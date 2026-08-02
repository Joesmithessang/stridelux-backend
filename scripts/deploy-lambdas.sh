#!/bin/bash

# Lambda Deployment Wrapper Script
# This script runs the Node.js deployment script with proper error handling

set -e  # Exit on first error

echo "Starting Lambda deployment..."

# Navigate to project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( dirname "$SCRIPT_DIR" )"

cd "$PROJECT_ROOT"

# Run the Node.js deployment script
node scripts/deploy-lambdas.js "$@"
