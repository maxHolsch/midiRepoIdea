<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/bundled/promptdj-midi

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Hand Tracking Accuracy

- Preferred tracker: MediaPipe Tasks HandLandmarker (WASM) is used for higher-accuracy fingertip positions and pinch detection. It loads the model and WASM at runtime from public CDNs.
- Fallback: If Tasks cannot load, the app falls back to the legacy MediaPipe Hands scripts already included in `index.html`.
- Smoothing: A light exponential smoother reduces fingertip jitter for steadier control. You can adjust it at runtime via the DevTools console on the component instance: `document.querySelector('prompt-dj-midi').smoothingAlpha = 0.6` (higher = more responsive, lower = smoother).

Notes:
- The Tasks runtime fetches assets from `jsdelivr` and `storage.googleapis.com`. Ensure your environment allows those domains.
- No additional install is required; everything is loaded on demand in the browser.
