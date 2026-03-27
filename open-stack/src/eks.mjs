import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  printStep,
  printSuccess,
  printError,
  printWarning,
  printInfo,
  createSpinner,
} from './ui.mjs';
import { tagResource } from './aws.mjs';
import chalk from 'chalk';

const HELM_CHART_REPO = 'https://github.com/kylehounslow/observability-stack.git';
const HELM_CHART_BRANCH = 'feat/helm-charts';
const HELM_CHART_PATH = 'charts/observability-stack';
const HELM_RELEASE_NAME = 'obs-stack';
const HELM_NAMESPACE = 'observability';

const OTEL_DEMO_REPO = 'https://open-telemetry.github.io/opentelemetry-helm-charts';
const OTEL_DEMO_RELEASE_NAME = 'otel-demo';
const OTEL_DEMO_NAMESPACE = 'otel-demo';

// ── Prerequisites ───────────────────────────────────────────────────────────

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function checkDemoPrerequisites() {
  printStep('Checking demo prerequisites...');
  console.error();

  const required = [
    { cmd: 'aws', install: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html' },
    { cmd: 'eksctl', install: 'https://eksctl.io/installation/' },
    { cmd: 'kubectl', install: 'https://kubernetes.io/docs/tasks/tools/' },
    { cmd: 'helm', install: 'https://helm.sh/docs/intro/install/' },
    { cmd: 'git', install: 'https://git-scm.com/downloads' },
  ];

  const missing = [];
  for (const { cmd, install } of required) {
    if (commandExists(cmd)) {
      printSuccess(`${cmd} found`);
    } else {
      missing.push({ cmd, install });
      printError(`${cmd} not found`);
    }
  }

  if (missing.length > 0) {
    console.error();
    console.error(`  ${chalk.bold('Missing required tools:')}`);
    for (const { cmd, install } of missing) {
      console.error(`    ${chalk.bold(cmd)}: ${chalk.underline(install)}`);
    }
    console.error();
    process.exit(1);
  }

  console.error();
}

// ── EKS Cluster ─────────────────────────────────────────────────────────────

function runCommand(cmd, args, { spinner, prefix = '' } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (spinner && line.trim()) {
          spinner.text = `${prefix}${line.trim()}`;
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (spinner && line.trim()) {
          spinner.text = `${prefix}${line.trim()}`;
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `Command failed with exit code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

export async function createEksCluster(cfg) {
  const { clusterName, region, nodeCount, instanceType, stackName, accountId } = cfg;

  printStep(`Creating EKS cluster '${clusterName}'...`);
  console.error();

  // Check if cluster already exists
  try {
    const existing = execSync(
      `eksctl get cluster --name ${clusterName} --region ${region} 2>/dev/null`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (existing.includes(clusterName)) {
      printSuccess(`Cluster '${clusterName}' already exists`);
      printInfo('Updating kubeconfig...');
      execSync(
        `aws eks update-kubeconfig --name ${clusterName} --region ${region}`,
        { stdio: 'ignore' },
      );
      printSuccess('kubeconfig updated');
      return;
    }
  } catch { /* cluster doesn't exist — proceed to create */ }

  const spinner = createSpinner('Creating EKS cluster (15-25 min)...');
  spinner.start();

  try {
    await runCommand('eksctl', [
      'create', 'cluster',
      '--name', clusterName,
      '--region', region,
      '--nodes', String(nodeCount),
      '--node-type', instanceType,
      '--managed',
    ], { spinner, prefix: 'EKS: ' });

    spinner.succeed(`Cluster '${clusterName}' created`);
  } catch (err) {
    spinner.fail('Failed to create EKS cluster');
    console.error();
    console.error(`  ${chalk.dim(err.message)}`);
    console.error();
    throw new Error('Failed to create EKS cluster');
  }

  // Tag the EKS cluster for stack discovery
  if (stackName && accountId) {
    const clusterArn = `arn:aws:eks:${region}:${accountId}:cluster/${clusterName}`;
    await tagResource(region, clusterArn, stackName);
    printSuccess('Cluster tagged');
  }

  // Update kubeconfig
  try {
    execSync(
      `aws eks update-kubeconfig --name ${clusterName} --region ${region}`,
      { stdio: 'ignore' },
    );
    printSuccess('kubeconfig updated');
  } catch (err) {
    printWarning(`Could not update kubeconfig: ${err.message}`);
    printInfo(`Run: aws eks update-kubeconfig --name ${clusterName} --region ${region}`);
  }
}

// ── Helm Chart Installation ─────────────────────────────────────────────────

export async function installHelmChart(cfg) {
  printStep('Installing observability stack Helm chart...');
  console.error();

  const tmpDir = mkdtempSync(join(tmpdir(), 'obs-stack-'));
  const chartDir = join(tmpDir, 'observability-stack', HELM_CHART_PATH);

  try {
    // Clone the chart repo
    const cloneSpinner = createSpinner('Cloning Helm chart repository...');
    cloneSpinner.start();

    try {
      await runCommand('git', [
        'clone',
        '--branch', HELM_CHART_BRANCH,
        '--depth', '1',
        HELM_CHART_REPO,
        join(tmpDir, 'observability-stack'),
      ], { spinner: cloneSpinner });
      cloneSpinner.succeed('Chart repository cloned');
    } catch (err) {
      cloneSpinner.fail('Failed to clone chart repository');
      console.error(`  ${chalk.dim(err.message)}`);
      throw new Error('Failed to clone Helm chart repository');
    }

    // Patch: remove duplicate data-prepper metrics port (4900).
    // The subchart template hardcodes a "server" port on 4900, so having
    // "metrics: 4900" in values.yaml causes a duplicate port warning.
    try {
      const valuesPath = join(chartDir, 'values.yaml');
      const values = readFileSync(valuesPath, 'utf-8');
      writeFileSync(valuesPath, values.replace(/^\s*- name: metrics\n\s*port: 4900\n/m, ''));
    } catch { /* best effort — chart may have been fixed upstream */ }

    // Build dependencies
    const depSpinner = createSpinner('Building Helm dependencies...');
    depSpinner.start();

    try {
      await runCommand('helm', ['dependency', 'build', chartDir], { spinner: depSpinner });
      depSpinner.succeed('Helm dependencies built');
    } catch (err) {
      depSpinner.fail('Failed to build Helm dependencies');
      console.error(`  ${chalk.dim(err.message)}`);
      throw new Error('Failed to build Helm dependencies');
    }

    // Install chart
    const installSpinner = createSpinner('Installing Helm chart (this may take a few minutes)...');
    installSpinner.start();

    const helmArgs = [
      'install', HELM_RELEASE_NAME, chartDir,
      '--namespace', HELM_NAMESPACE,
      '--create-namespace',
      '--wait',
      '--timeout', '20m',
    ];

    // If the stack config has an OTLP endpoint, pass it as a value override
    if (cfg.otlpEndpoint) {
      helmArgs.push('--set', `opentelemetry-collector.config.exporters.otlp/osi.endpoint=${cfg.otlpEndpoint}`);
    }

    try {
      await runCommand('helm', helmArgs, { spinner: installSpinner });
      installSpinner.succeed('Helm chart installed');
    } catch (err) {
      // Check if release already exists
      if (/already exists/i.test(err.message) || /cannot re-use/i.test(err.message)) {
        installSpinner.succeed(`Release '${HELM_RELEASE_NAME}' already installed`);
        printInfo(`To upgrade: helm upgrade ${HELM_RELEASE_NAME} ${chartDir} -n ${HELM_NAMESPACE}`);
        return;
      }
      installSpinner.fail('Failed to install Helm chart');
      console.error(`  ${chalk.dim(err.message)}`);
      throw new Error('Failed to install Helm chart');
    }

    // Show deployment status
    console.error();
    printSuccess('Demo services deployed to EKS');
    printInfo(`Namespace: ${HELM_NAMESPACE}`);
    printInfo(`Release: ${HELM_RELEASE_NAME}`);
    printInfo(`Check status: kubectl get pods -n ${HELM_NAMESPACE}`);
  } finally {
    // Clean up temp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best effort cleanup */ }
  }
}

// ── OpenTelemetry Demo ────────────────────────────────────────────────────

export async function installOtelDemo(cfg) {
  printStep('Installing OpenTelemetry Demo...');
  console.error();

  // Add the Helm repo
  const repoSpinner = createSpinner('Adding OpenTelemetry Helm repo...');
  repoSpinner.start();

  try {
    await runCommand('helm', [
      'repo', 'add', 'open-telemetry', OTEL_DEMO_REPO,
    ], { spinner: repoSpinner });
    await runCommand('helm', ['repo', 'update'], { spinner: repoSpinner });
    repoSpinner.succeed('OpenTelemetry Helm repo added');
  } catch (err) {
    // Repo may already exist — try update anyway
    try {
      await runCommand('helm', ['repo', 'update'], { spinner: repoSpinner });
      repoSpinner.succeed('OpenTelemetry Helm repo updated');
    } catch (updateErr) {
      repoSpinner.fail('Failed to add Helm repo');
      console.error(`  ${chalk.dim(updateErr.message)}`);
      throw new Error('Failed to add OpenTelemetry Helm repo');
    }
  }

  // Install the OpenTelemetry Demo chart
  const installSpinner = createSpinner('Installing OpenTelemetry Demo (this may take a few minutes)...');
  installSpinner.start();

  const helmArgs = [
    'install', OTEL_DEMO_RELEASE_NAME, 'open-telemetry/opentelemetry-demo',
    '--namespace', OTEL_DEMO_NAMESPACE,
    '--create-namespace',
    '--wait',
    '--timeout', '10m',
    // Disable the demo's built-in observability backends — we use our own stack
    '--set', 'opensearch.enabled=false',
    '--set', 'grafana.enabled=false',
    '--set', 'prometheus.enabled=false',
    '--set', 'jaeger.enabled=false',
  ];

  // Point the demo's collector at the observability stack's collector
  if (cfg.otlpEndpoint) {
    helmArgs.push(
      '--set', `opentelemetry-collector.config.exporters.otlp/osi.endpoint=${cfg.otlpEndpoint}`,
    );
  } else {
    // Default: send to the obs-stack collector in the observability namespace
    helmArgs.push(
      '--set', `default.env[0].name=OTEL_EXPORTER_OTLP_ENDPOINT`,
      '--set', `default.env[0].value=http://${HELM_RELEASE_NAME}-opentelemetry-collector.${HELM_NAMESPACE}:4317`,
    );
  }

  try {
    await runCommand('helm', helmArgs, { spinner: installSpinner });
    installSpinner.succeed('OpenTelemetry Demo installed');
  } catch (err) {
    if (/already exists/i.test(err.message) || /cannot re-use/i.test(err.message)) {
      installSpinner.succeed(`Release '${OTEL_DEMO_RELEASE_NAME}' already installed`);
      return;
    }
    installSpinner.fail('Failed to install OpenTelemetry Demo');
    console.error(`  ${chalk.dim(err.message)}`);
    throw new Error('Failed to install OpenTelemetry Demo');
  }

  console.error();
  printSuccess('OpenTelemetry Demo deployed');
  printInfo(`Namespace: ${OTEL_DEMO_NAMESPACE}`);
  printInfo(`Release: ${OTEL_DEMO_RELEASE_NAME}`);
  printInfo(`Check status: kubectl get pods -n ${OTEL_DEMO_NAMESPACE}`);
  printInfo(`Frontend: kubectl port-forward svc/${OTEL_DEMO_RELEASE_NAME}-frontend-proxy 8080:8080 -n ${OTEL_DEMO_NAMESPACE}`);
}
