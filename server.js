// Deployment entry point - build WebXR bundle then start app
import { execSync } from 'child_process';
import { existsSync } from 'fs';

if (!existsSync('public/webxr-vtk-bundle.js')) {
    console.log('Building WebXR vtk.js bundle...');
    execSync('npx esbuild src/webxr-entry.js --bundle --format=esm --outfile=public/webxr-vtk-bundle.js', {
        stdio: 'inherit'
    });
    console.log('WebXR bundle built.');
}

import './src/app.js';
