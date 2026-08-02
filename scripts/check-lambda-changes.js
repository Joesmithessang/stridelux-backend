#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
  console.log(`Output: ${name}=${value}`);
}

function checkForLambdaChanges() {
  try {
    let base;
    if (process.env.GITHUB_EVENT_NAME === 'push') {
      base = 'HEAD~1';
    } else if (process.env.GITHUB_BASE_REF) {
      base = `origin/${process.env.GITHUB_BASE_REF}`;
    } else {
      base = 'origin/main';
    }

    console.log(`Comparing against: ${base} (event: ${process.env.GITHUB_EVENT_NAME || 'local'})`);

    const output = execSync(
      `git diff --name-only ${base}...HEAD -- lambdas/`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    const changedFiles = output
      .split('\n')
      .filter(f => f && f !== 'lambdas/config.json' && f !== 'lambdas/README.md');

    if (changedFiles.length > 0) {
      console.log('\nLambda changes detected:');
      changedFiles.forEach(f => console.log(`   - ${f}`));
      setOutput('lambda_changes', 'true');
    } else {
      console.log('No Lambda code changes detected (config/README changes ignored)');
      setOutput('lambda_changes', 'false');
    }

    process.exit(0);
  } catch (error) {
    if (error.status === 128) {
      console.log('Unable to compare commits. Assuming no Lambda changes.');
      setOutput('lambda_changes', 'false');
      process.exit(0);
    }
    console.error('Unexpected error during lambda check:', error.message);
    process.exit(1);
  }
}

checkForLambdaChanges();
