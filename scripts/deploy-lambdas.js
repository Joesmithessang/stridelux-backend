#!/usr/bin/env node

/**
 * Lambda Deployment Script
 * 
 * Intelligently deploys Lambda functions to AWS using AWS CLI.
 * - Detects changed Lambda files and deploys only those functions
 * - Supports both simple (index.js only) and complex (with dependencies) functions
 * - Zips the function code and uploads via AWS CLI
 * 
 * Usage:
 *   node scripts/deploy-lambdas.js                      # Deploy all changed Lambdas
 *   node scripts/deploy-lambdas.js --function=my-func   # Deploy specific Lambda
 *   node scripts/deploy-lambdas.js --dry-run            # Show what would be deployed
 *   node scripts/deploy-lambdas.js --all                # Force deploy all Lambdas
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createReadStream, createWriteStream } = require('fs');

// ─────────────────────────────────────────────────────────────
// CONFIG & CONSTANTS
// ─────────────────────────────────────────────────────────────

const LAMBDAS_DIR = path.join(__dirname, '..', 'lambdas');
const CONFIG_PATH = path.join(LAMBDAS_DIR, 'config.json');
const TEMP_DIR = path.join(__dirname, '..', 'build', '.lambda-temp');

// Parse CLI arguments
const args = process.argv.slice(2);
const opts = {
  dryRun: args.includes('--dry-run'),
  all: args.includes('--all'),
  function: null,
};

args.forEach(arg => {
  if (arg.startsWith('--function=')) {
    opts.function = arg.split('=')[1];
  }
});

// ─────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────────────────────

/**
 * Get list of changed files in lambdas/ directory since last deployment
 */
function getChangedLambdaFiles() {
  try {
    // Get files changed in lambdas/ directory
    const output = execSync('git diff --name-only HEAD~1 HEAD -- lambdas/', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (!output) return [];

    return output.split('\n').filter(f => f.startsWith('lambdas/'));
  } catch (error) {
    // If we can't get git diff (e.g., first commit), return empty
    console.warn('⚠️  Could not get git diff. Deploying only specified functions or all if --all flag used.');
    return [];
  }
}

/**
 * Extract function config keys from changed files.
 * Matches the changed directory name against config.directory entries
 * because config keys (e.g. "admin") differ from directory names
 * (e.g. "stridelux-admin-fn").
 */
function extractFunctionNamesFromChanges(changedFiles, allFunctions) {
  const functionNames = new Set();

  // Build a reverse map: directory name → config key
  const dirToKey = {};
  Object.entries(allFunctions).forEach(([key, cfg]) => {
    dirToKey[cfg.directory] = key;
  });

  changedFiles.forEach(file => {
    if (file === 'lambdas/config.json' || file === 'lambdas/README.md') return;

    // Extract directory segment: lambdas/<dir>/... → <dir>
    const match = file.match(/^lambdas\/([^/]+)\//);
    if (!match) return;

    const changedDir = match[1];
    const configKey = dirToKey[changedDir];
    if (configKey) {
      functionNames.add(configKey);
    } else {
      console.warn(`  ⚠️  Changed dir "${changedDir}" not found in config — skipping`);
    }
  });

  return Array.from(functionNames);
}

/**
 * Load and validate Lambda configuration
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('❌ config.json not found at', CONFIG_PATH);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  return config.functions || {};
}

/**
 * Install npm production dependencies for functions that bundle third-party packages.
 * Controlled by the npmInstall flag in config.json.
 */
function installDependencies(functionName, config) {
  if (!config.npmInstall) return;

  const functionDir = path.join(LAMBDAS_DIR, config.directory);
  const pkgPath = path.join(functionDir, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    console.warn(`  ⚠️  npmInstall=true but no package.json found in ${functionDir} — skipping`);
    return;
  }

  console.log(`  📥 Installing production dependencies: ${functionName}`);
  try {
    execSync('npm ci --production', { cwd: functionDir, stdio: 'pipe' });
    console.log(`  ✓ Dependencies installed`);
  } catch (error) {
    throw new Error(`npm ci failed for ${functionName}: ${error.message}`);
  }
}

/**
 * Create a zip file for a Lambda function
 */
function zipLambdaFunction(functionName, config) {
  const functionDir = path.join(LAMBDAS_DIR, config.directory);

  if (!fs.existsSync(functionDir)) {
    throw new Error(`Function directory not found: ${functionDir}`);
  }

  // Ensure temp directory exists
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const zipPath = path.join(TEMP_DIR, `${functionName}.zip`);

  console.log(`  📦 Zipping: ${functionDir}`);

  // Lambda requires index.js (and node_modules/ when present) at the ROOT
  // of the zip — not nested under a subdirectory. Use different strategies:
  //   npmInstall=true  → cd into the function dir and zip everything (.)
  //   npmInstall=false → zip just index.js with -j to strip the path prefix
  try {
    if (process.platform === 'win32') {
      const psCommand = `
        $ProgressPreference = 'SilentlyContinue';
        Compress-Archive -Path "${functionDir}/*" -DestinationPath "${zipPath}" -Force
      `;
      execSync(`powershell -Command "${psCommand}"`, { stdio: 'pipe' });
    } else if (config.npmInstall) {
      // cd into the function directory so node_modules/ and index.js land at zip root
      execSync(`cd "${functionDir}" && zip -r "${zipPath}" .`, { stdio: 'pipe' });
    } else {
      // -j junk-paths: strips the directory prefix so index.js is at zip root
      execSync(`zip -j "${zipPath}" "${path.join(functionDir, 'index.js')}"`, { stdio: 'pipe' });
    }

    const stats = fs.statSync(zipPath);
    console.log(`  ✓ Created: ${zipPath} (${(stats.size / 1024).toFixed(2)} KB)`);

    return zipPath;
  } catch (error) {
    throw new Error(`Failed to zip ${functionName}: ${error.message}`);
  }
}

/**
 * Deploy a Lambda function to AWS using AWS CLI
 */
function deployLambdaToAWS(functionName, config, zipPath) {
  const awsFunctionName = config.awsFunctionName;

  console.log(`  🚀 Deploying to AWS: ${awsFunctionName}`);

  try {
    // Update Lambda code
    const cmd = `aws lambda update-function-code --function-name "${awsFunctionName}" --zip-file fileb://"${zipPath}"`;

    const output = execSync(cmd, {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env }
    });

    console.log(`  ✓ Deployed successfully`);
    return true;
  } catch (error) {
    console.error(`  ❌ Deployment failed: ${error.message}`);
    return false;
  }
}

/**
 * Verify AWS CLI is installed and credentials are configured
 */
function verifyAWSSetup() {
  try {
    execSync('aws sts get-caller-identity', {
      stdio: 'pipe',
      encoding: 'utf-8'
    });
    return true;
  } catch (error) {
    console.error('❌ AWS CLI not configured or not installed. Please run:');
    console.error('   aws configure');
    console.error('   Or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables');
    return false;
  }
}

/**
 * Clean up temporary files
 */
function cleanup() {
  try {
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true });
      console.log('✓ Cleaned up temporary files');
    }
  } catch (error) {
    console.warn('⚠️  Could not clean up temp directory:', error.message);
  }
}

// ─────────────────────────────────────────────────────────────
// MAIN LOGIC
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('   🔧 StrideLux Lambda Deployment');
  console.log('═══════════════════════════════════════════════════════════\n');

  // 1. Verify AWS setup
  if (!opts.dryRun && !verifyAWSSetup()) {
    process.exit(1);
  }

  // 2. Load config
  console.log('📋 Loading Lambda configuration...');
  const allFunctions = loadConfig();
  console.log(`   Found ${Object.keys(allFunctions).length} Lambda functions\n`);

  // 3. Determine which Lambdas to deploy
  let functionsToDeployNames = [];

  if (opts.function) {
    // Specific function requested
    if (!allFunctions[opts.function]) {
      console.error(`❌ Unknown function: ${opts.function}`);
      process.exit(1);
    }
    functionsToDeployNames = [opts.function];
    console.log(`📌 Deploying specific function: ${opts.function}\n`);
  } else if (opts.all) {
    // Deploy all
    functionsToDeployNames = Object.keys(allFunctions);
    console.log(`📌 Forcing deployment of all ${functionsToDeployNames.length} functions\n`);
  } else {
    // Detect changes
    console.log('🔍 Detecting changed Lambda files...');
    const changedFiles = getChangedLambdaFiles();

    if (changedFiles.length === 0) {
      console.log('   No Lambda files changed. Skipping deployment.\n');
      return;
    }

    console.log(`   Changed files: ${changedFiles.length}`);
    changedFiles.forEach(f => console.log(`     - ${f}`));

    functionsToDeployNames = extractFunctionNamesFromChanges(changedFiles, allFunctions);
    if (functionsToDeployNames.length === 0) {
      console.log('\n   No Lambda functions affected. Skipping deployment.\n');
      return;
    }

    console.log(`\n📌 Deploying ${functionsToDeployNames.length} changed function(s):\n`);
  }

  // 4. Deploy each function
  const deployments = [];

  for (const functionName of functionsToDeployNames) {
    const config = allFunctions[functionName];

    console.log(`\n📦 Processing: ${functionName}`);
    console.log(`   AWS Function: ${config.awsFunctionName}`);

    try {
      installDependencies(functionName, config);
      const zipPath = zipLambdaFunction(functionName, config);

      if (opts.dryRun) {
        console.log(`  🔍 [DRY-RUN] Would deploy: ${zipPath}`);
        deployments.push({ functionName, status: 'dry-run' });
      } else {
        const success = deployLambdaToAWS(functionName, config, zipPath);
        deployments.push({ functionName, status: success ? 'success' : 'failed' });
      }
    } catch (error) {
      console.error(`  ❌ Error: ${error.message}`);
      deployments.push({ functionName, status: 'error' });
    }
  }

  // 5. Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('   📊 Deployment Summary\n');

  const successful = deployments.filter(d => d.status === 'success').length;
  const failed = deployments.filter(d => d.status === 'failed').length;
  const errors = deployments.filter(d => d.status === 'error').length;
  const dryRuns = deployments.filter(d => d.status === 'dry-run').length;

  deployments.forEach(d => {
    const icon =
      d.status === 'success' ? '✅' :
      d.status === 'failed' ? '❌' :
      d.status === 'error' ? '⚠️ ' :
      '🔍';
    console.log(`   ${icon} ${d.functionName}: ${d.status}`);
  });

  console.log('\n   Total:');
  if (opts.dryRun) {
    console.log(`   - Dry-run: ${dryRuns}`);
  } else {
    console.log(`   - Successful: ${successful}`);
    console.log(`   - Failed: ${failed}`);
    console.log(`   - Errors: ${errors}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════\n');

  // 6. Cleanup
  if (!opts.dryRun) {
    cleanup();
  }

  // Exit with error if any deployments failed
  if (!opts.dryRun && (failed > 0 || errors > 0)) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error.message);
  cleanup();
  process.exit(1);
});
