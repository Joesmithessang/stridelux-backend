#!/usr/bin/env node

/**
 * Lambda Change Detection Script
 * 
 * Checks if any Lambda code has changed compared to the base branch.
 * Returns exit code 0 if changes detected, 1 if no changes.
 * 
 * This is used by GitHub Actions to conditionally run Lambda deployment.
 * 
 * Usage:
 *   node scripts/check-lambda-changes.js
 */

const { execSync } = require('child_process');

function checkForLambdaChanges() {
  try {
    // On a push to main (after PR merge), origin/main == HEAD so the diff
    // is always empty. Use HEAD~1 instead — fetch-depth: 2 makes it available.
    // On a pull_request event, compare against the target branch on origin.
    let base;
    if (process.env.GITHUB_EVENT_NAME === 'push') {
      base = 'HEAD~1';
    } else if (process.env.GITHUB_BASE_REF) {
      base = `origin/${process.env.GITHUB_BASE_REF}`;
    } else {
      base = 'origin/main';
    }

    console.log(`Comparing against: ${base} (event: ${process.env.GITHUB_EVENT_NAME || 'local'})`);

    // Get list of changed files in lambdas/ directory
    const output = execSync(
      `git diff --name-only ${base}...HEAD -- lambdas/`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    const changedFiles = output.split('\n').filter(f => f && f !== 'lambdas/config.json' && f !== 'lambdas/README.md');

    if (changedFiles.length > 0) {
      console.log('\n✅ Lambda changes detected:');
      changedFiles.forEach(f => console.log(`   - ${f}`));
      console.log('\n');
      process.exit(0); // Changes detected
    } else {
      console.log('✅ No Lambda code changes detected (config/README changes ignored)');
      process.exit(1); // No changes
    }
  } catch (error) {
    if (error.status === 128) {
      // Git error - likely first commit or branch doesn't exist
      console.log('⚠️  Unable to compare (likely first commit). Assuming no Lambda changes.');
      process.exit(1);
    }
    console.error('Error checking Lambda changes:', error.message);
    process.exit(1);
  }
}

checkForLambdaChanges();
