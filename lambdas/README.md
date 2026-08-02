# Lambda Functions

This directory contains all AWS Lambda functions for StrideLux. Each Lambda function can be a single `index.js` file or a directory with dependencies.

## Directory Structure

Each Lambda function lives in its own subdirectory:

```
lambdas/
├── README.md
├── config.json                    # Maps function directories to AWS Lambda names
├── function-name-1/               # Simple function (just index.js)
│   └── index.js
├── function-name-2/               # Function with dependencies
│   ├── package.json
│   ├── index.js
│   ├── lib/
│   │   └── helpers.js
│   └── node_modules/              # Generated during npm install
└── function-name-3/
    ├── package.json
    ├── index.js
    └── node_modules/
```

## Adding a New Lambda Function

### For a simple function (no dependencies):
1. Create a folder: `lambdas/my-function/`
2. Add `lambdas/my-function/index.js` with your handler
3. Update `config.json`:
   ```json
   "my-function": {
     "directory": "my-function",
     "awsFunctionName": "stridelux-my-function",
     "handler": "index.handler",
     "runtime": "nodejs20.x"
   }
   ```

### For a function with dependencies:
1. Create a folder: `lambdas/my-api-function/`
2. Add `package.json` and `index.js`
3. Run `npm install` inside that folder
4. Add to `config.json` (same structure as above)
5. When deployed, the entire folder (including `node_modules/`) is zipped

## Deploying

### Manual deployment:
```bash
# Deploy all Lambdas
node scripts/deploy-lambdas.js

# Deploy a specific Lambda
node scripts/deploy-lambdas.js --function=my-function

# Dry run (show what would be deployed)
node scripts/deploy-lambdas.js --dry-run
```

### Automatic deployment:
- Push to `dev` → Lambdas are deployed to production (via main)
- Only files under `lambdas/` are zipped and uploaded
- If only React code (`src/`) changed → Lambda deployment is skipped

## Notes

- **Node modules**: Include in the zip if your Lambda has dependencies. AWS will extract them at deployment time.
- **File size limit**: Lambda deployment packages must be ≤50 MB zipped
- **Layer support**: For shared code, consider Lambda Layers (not yet configured)
- **Versioning**: Each deployment creates a new version in AWS, but aliases (if configured) may still point to older versions
