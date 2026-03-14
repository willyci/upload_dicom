# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DICOM Processor — a web-based medical imaging platform that processes DICOM uploads into multiple 3D/2D formats (VTI, NRRD, NIfTI, STL, VTK, JPG, MPR slices) with interactive viewers and WebXR support.

## Commands

- `npm start` — Start server (builds WebXR bundle if missing, then runs `node server.js`)
- `npm run dev` — Development with auto-reload via nodemon (`nodemon src/app.js`)
- `npm run build:webxr` — Rebuild the WebXR vtk.js bundle (`public/webxr-vtk-bundle.js`) via esbuild

No test suite or linter is configured.

## Architecture

**ES Modules** — `"type": "module"` in package.json. Use `import`/`export` syntax.

### Backend (Node.js/Express)

- **`server.js`** — Deployment entry point. Checks for WebXR bundle, builds if missing, then imports `src/app.js`.
- **`src/app.js`** — Express server. HTTP on port 3000, HTTPS on port 3443 (auto-generates self-signed certs in `certs/` for WebXR). Sets 600s keepalive for large uploads.
- **`src/routes/uploads.js`** — Upload endpoints. `POST /upload` accepts ZIP or .dcm files (200 file limit, 2GB per file). `DELETE /delete-upload`, `GET /list-uploads`, `GET /processing-status`.
- **`src/services/processor.js`** — Processing pipeline orchestrator. Two-pass approach: (1) metadata extraction with `dicom-parser`, (2) pixel data extraction to temp file. Runs 5 volume converters in parallel (VTI, NRRD, NIfTI, STL, VTK), then generates MPR slices.
- **`src/converters/`** — Individual format converters: `vti.js`, `nrrd.js`, `nifti.js`, `stl.js`, `vtk.js`, `jpg.js`, `mpr.js`. Each takes volume metadata and writes output files.
- **`src/utils/volumeBuilder.js`** — Two-pass volume builder that writes pixel data to a temp file (`/tmp/dicom_vol_*.raw`) to avoid holding entire volumes in memory. Returns volume object with metadata + cleanup method.
- **`src/utils/progress.js`** — Simple status string store for real-time UI updates.

### Frontend (Vanilla HTML/JS)

All viewers are in `public/` as standalone HTML files with no build step or framework:

- **`index.html`** — Main upload dashboard with drag-drop, progress tracking, upload grid
- **Desktop viewers** (`volume-viewer.html`, `stl-viewer.html`, `mpr-viewer.html`, etc.) — Use vtk.js UMD bundle from CDN
- **`webvr-viewer.html`** — WebXR volume rendering via `@kitware/vtk.js` ES modules (esm.sh CDN with importmap)
- **`vr-viewer.html`** — WebXR mesh rendering via Three.js

### Key Design Decisions

- **Memory management is critical** — DICOM volumes can be very large. The codebase uses temp files, streaming base64 encoding (3-4MB chunks), manual GC calls (with `--expose-gc`), explicit null assignments, and event loop yielding every 10 slices.
- **WebXR requires HTTPS** — The server runs dual HTTP/HTTPS. Self-signed certs are auto-generated using an openssl config file approach (not `-subj` flag, which fails on Windows).
- **The vtk.js UMD bundle does NOT include WebXR modules** — WebXR requires `@kitware/vtk.js` ES modules. The `src/webxr-entry.js` is bundled by esbuild into `public/webxr-vtk-bundle.js`.
- **Generated files** go to `public/uploads/` (one subfolder per upload). This directory is gitignored.

## DICOM Processing Pipeline

1. Upload received (ZIP extracted or .dcm files saved)
2. Recursive .dcm file discovery in upload directory
3. Two-pass volume build (metadata pass → pixel data pass with temp file)
4. Per-slice callbacks generate JPG thumbnails and bump maps during pass 2
5. Five volume converters run in parallel (VTI, NRRD, NIfTI, STL, VTK)
6. MPR cross-sections generated (axial, sagittal, coronal)
7. `dicom_info.json` written with metadata for the upload
8. webxr viewer,