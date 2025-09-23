/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { css, html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';

import { throttle } from '../utils/throttle';

import './PromptController';
import './PlayPauseButton';
import type { PlaybackState, Prompt } from '../types';
import { MidiDispatcher } from '../utils/MidiDispatcher';

/** The grid of prompt inputs. */
@customElement('prompt-dj-midi')
export class PromptDjMidi extends LitElement {
  static override styles = css`
    :host {
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      box-sizing: border-box;
      position: relative;
    }
    #camera-wrap {
      position: absolute;
      inset: 0;
      z-index: -2;
      overflow: hidden;
      background: #000;
    }
    #camera {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform: scaleX(-1); /* mirror for easier control */
      filter: saturate(0.8) brightness(0.9);
    }
    #overlay {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 5; /* above UI elements */
    }
    #background {
      will-change: background-image;
      position: absolute;
      height: 100%;
      width: 100%;
      z-index: -1;
      background: transparent; /* allow camera to show through */
    }
    /* Bottom panel holds the prompt grid anchored to lower screen */
    #bottom-panel {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 2vmin 3vmin 3vmin;
      box-sizing: border-box;
      display: flex;
      justify-content: center;
      align-items: flex-end;
      pointer-events: none; /* allow overlay gestures */
    }
    #grid {
      width: min(96vw, 140vmin);
      height: min(65vh, 80vmin);
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      grid-auto-rows: 1fr;
      gap: 1.5vmin;
      pointer-events: auto; /* still allow pointer for mouse */
    }
    prompt-controller {
      width: 100%;
      height: 100%;
    }
    play-pause-button {
      position: relative;
      width: 15vmin;
    }
    #buttons {
      position: absolute;
      top: 0;
      left: 0;
      padding: 5px;
      display: flex;
      gap: 5px;
    }
    button {
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      color: #fff;
      background: #0002;
      -webkit-font-smoothing: antialiased;
      border: 1.5px solid #fff;
      border-radius: 4px;
      user-select: none;
      padding: 3px 6px;
      &.active {
        background-color: #fff;
        color: #000;
      }
    }
    select {
      font: inherit;
      padding: 5px;
      background: #fff;
      color: #000;
      border-radius: 4px;
      border: none;
      outline: none;
      cursor: pointer;
    }

    /* Instrument sidebar */
    #instrument-panel {
      position: absolute;
      top: 10%;
      right: 0;
      bottom: 10%;
      width: clamp(120px, 16vmin, 220px);
      display: flex;
      flex-direction: column;
      gap: 0.8vmin;
      padding: 1vmin;
      box-sizing: border-box;
      justify-content: center;
      align-items: stretch;
      pointer-events: none; /* selection via pinch/overlay */
    }
    .instrument {
      pointer-events: auto;
      border: 2px solid #fff9;
      color: #fff;
      background: #0006;
      padding: 0.6em 0.8em;
      border-radius: 8px 0 0 8px;
      font-weight: 700;
      text-align: center;
      -webkit-font-smoothing: antialiased;
      user-select: none;
      transform: translateX(0);
      transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
    }
    .instrument.selected {
      background: #ffe600ee;
      border-color: #ffe600;
      color: #000;
      transform: translateX(-6px);
    }
    .instrument .label {
      font-size: clamp(12px, 1.8vmin, 18px);
      letter-spacing: 0.02em;
    }
    .instrument .sub {
      opacity: 0.8;
      font-size: clamp(10px, 1.3vmin, 14px);
      font-weight: 600;
    }
  `;

  private prompts: Map<string, Prompt>;
  private midiDispatcher: MidiDispatcher;

  @property({ type: Boolean }) private showMidi = false;
  @property({ type: String }) public playbackState: PlaybackState = 'stopped';
  @state() public audioLevel = 0;
  @state() private midiInputIds: string[] = [];
  @state() private activeMidiInputId: string | null = null;
  @state() private selectedPromptId: string | null = null;
  @state() private activePromptId: string | null = null;

  // Hand tracking state
  private videoEl: HTMLVideoElement | null = null;
  private overlayEl: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;
  private cameraRunning = false;
  private selectionStartTs: number | null = null; // legacy, unused for rotation
  private movementAccumulator = 0; // legacy, unused for rotation
  private lastFingerPos: { x: number; y: number } | null = null; // legacy, unused for rotation
  private pinchDown = false;
  private pinchStartTs: number | null = null;
  private candidatePromptId: string | null = null;
  private rotationStartAngle: number | null = null;
  private baseWeight: number | null = null;
  private minWeightAllowed: number | null = null;
  private maxWeightAllowed: number | null = null;
  private pinchStartY: number | null = null; // for vertical weight adjustment while pinching

  // Instrument selection and simple synth
  @state() private instruments = [
    { name: 'Piano', key: 'piano' },
    { name: 'Guitar', key: 'guitar' },
    { name: 'Sitar', key: 'sitar' },
    { name: 'Flute', key: 'flute' },
    { name: 'Violin', key: 'violin' },
    { name: 'Bass', key: 'bass' },
    { name: 'Drums', key: 'drums' },
  ];
  @state() private selectedInstrument = 0;
  private audioCtx: AudioContext | null = null;
  private instrumentNodes: any = null; // built lazily

  // Piano banner + note state (pinch-only)
  private pianoKeys: Array<{x:number;y:number;w:number;h:number; note:number}> = [];
  // Active key index when pinching over the piano banner
  private pinchActiveKeyIndex: number | null = null;
  private activeVoices: Record<string, {o: OscillatorNode; g: GainNode; filter?: BiquadFilterNode}> = {};

  @property({ type: Object })
  private filteredPrompts = new Set<string>();

  constructor(
    initialPrompts: Map<string, Prompt>,
  ) {
    super();
    this.prompts = initialPrompts;
    this.midiDispatcher = new MidiDispatcher();
  }

  private handlePromptChanged(e: CustomEvent<Prompt>) {
    const { promptId, text, weight, cc } = e.detail;
    const prompt = this.prompts.get(promptId);

    if (!prompt) {
      console.error('prompt not found', promptId);
      return;
    }

    prompt.text = text;
    prompt.weight = weight;
    prompt.cc = cc;

    const newPrompts = new Map(this.prompts);
    newPrompts.set(promptId, prompt);

    this.prompts = newPrompts;
    this.requestUpdate();

    this.dispatchEvent(
      new CustomEvent('prompts-changed', { detail: this.prompts }),
    );
  }

  /** Generates radial gradients for each prompt based on weight and color. */
  private readonly makeBackground = throttle(
    () => {
      const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

      const MAX_WEIGHT = 0.5;
      const MAX_ALPHA = 0.6;

      const bg: string[] = [];

      [...this.prompts.values()].forEach((p, i) => {
        const alphaPct = clamp01(p.weight / MAX_WEIGHT) * MAX_ALPHA;
        const alpha = Math.round(alphaPct * 0xff)
          .toString(16)
          .padStart(2, '0');

        const stop = p.weight / 2;
        const x = (i % 4) / 3;
        const y = Math.floor(i / 4) / 3;
        const s = `radial-gradient(circle at ${x * 100}% ${y * 100}%, ${p.color}${alpha} 0px, ${p.color}00 ${stop * 100}%)`;

        bg.push(s);
      });

      return bg.join(', ');
    },
    30, // don't re-render more than once every XXms
  );

  private toggleShowMidi() {
    return this.setShowMidi(!this.showMidi);
  }

  public async setShowMidi(show: boolean) {
    this.showMidi = show;
    if (!this.showMidi) return;
    try {
      const inputIds = await this.midiDispatcher.getMidiAccess();
      this.midiInputIds = inputIds;
      this.activeMidiInputId = this.midiDispatcher.activeMidiInputId;
    } catch (e) {
      this.showMidi = false;
      this.dispatchEvent(new CustomEvent('error', {detail: e.message}));
    }
  }

  private handleMidiInputChange(event: Event) {
    const selectElement = event.target as HTMLSelectElement;
    const newMidiId = selectElement.value;
    this.activeMidiInputId = newMidiId;
    this.midiDispatcher.activeMidiInputId = newMidiId;
  }

  private playPause() {
    this.dispatchEvent(new CustomEvent('play-pause'));
  }

  public addFilteredPrompt(prompt: string) {
    this.filteredPrompts = new Set([...this.filteredPrompts, prompt]);
  }

  override render() {
    const bg = styleMap({
      backgroundImage: this.makeBackground(),
    });
    return html`
      <div id="camera-wrap">
        <video id="camera" autoplay muted playsinline></video>
      </div>
      <div id="background" style=${bg}></div>
      <canvas id="overlay"></canvas>
      <div id="buttons">
        <button
          @click=${this.toggleShowMidi}
          class=${this.showMidi ? 'active' : ''}
          >MIDI</button
        >
        <select
          @change=${this.handleMidiInputChange}
          .value=${this.activeMidiInputId || ''}
          style=${this.showMidi ? '' : 'visibility: hidden'}>
          ${this.midiInputIds.length > 0
        ? this.midiInputIds.map(
          (id) =>
            html`<option value=${id}>
                    ${this.midiDispatcher.getDeviceName(id)}
                  </option>`,
        )
        : html`<option value="">No devices found</option>`}
        </select>
      </div>
      <div id="instrument-panel">
        ${this.instruments.map((ins, i) => html`
          <div class="instrument ${this.selectedInstrument === i ? 'selected' : ''}" data-index=${i}>
            <div class="label">${ins.name}</div>
            <div class="sub">${i === this.selectedInstrument ? 'Active' : '&nbsp;'}</div>
          </div>
        `)}
      </div>
      <div id="bottom-panel">
        <div id="grid">${this.renderPrompts()}</div>
      </div>
      <play-pause-button .playbackState=${this.playbackState} @click=${this.playPause}></play-pause-button>`;
  }

  private renderPrompts() {
    return [...this.prompts.values()].map((prompt) => {
      return html`<prompt-controller
        promptId=${prompt.promptId}
        ?filtered=${this.filteredPrompts.has(prompt.text)}
        cc=${prompt.cc}
        text=${prompt.text}
        weight=${prompt.weight}
        color=${prompt.color}
        .midiDispatcher=${this.midiDispatcher}
        .showCC=${this.showMidi}
        audioLevel=${this.audioLevel}
        @prompt-changed=${this.handlePromptChanged}>
      </prompt-controller>`;
    });
  }

  // ============ Hand Tracking Integration ============
  override firstUpdated() {
    // Setup camera and overlay references
    this.videoEl = this.renderRoot.querySelector('#camera') as HTMLVideoElement;
    this.overlayEl = this.renderRoot.querySelector('#overlay') as HTMLCanvasElement;
    this.overlayCtx = this.overlayEl.getContext('2d');
    this.startCamera();
    // Release any sustained notes when tab loses visibility
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.handlePianoPinch(false, null);
        this.pinchDown = false;
      }
    });
  }

  private async startCamera() {
    if (!this.videoEl) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      this.videoEl.srcObject = stream;
      this.videoEl.onloadedmetadata = async () => {
        this.cameraRunning = true;
        this.resizeOverlay();
        try { await this.videoEl!.play(); } catch {}
        this.loop();
      };
      window.addEventListener('resize', () => this.resizeOverlay());
    } catch (e: any) {
      this.dispatchEvent(new CustomEvent('error', { detail: `Camera error: ${e.message || e}` }));
    }
  }

  private resizeOverlay() {
    if (!this.overlayEl) return;
    const rect = (this.renderRoot.host as HTMLElement).getBoundingClientRect();
    this.overlayEl.width = Math.max(1, Math.floor(rect.width));
    this.overlayEl.height = Math.max(1, Math.floor(rect.height));
  }

  // Hand tracking
  // Preferred: MediaPipe Tasks HandLandmarker (more accurate + robust)
  // Fallback: legacy MediaPipe Hands if Tasks is unavailable
  private handLandmarker: any = null;
  private handLandmarkerReady = false;
  private hands: any = null; // legacy fallback
  private handsReady = false;
  private lastHandsTs: number = 0; // last time we received hand results

  // Simple exponential smoothing for fingertips
  private smoothThumb: {x:number;y:number}|null = null;
  private smoothIndex: {x:number;y:number}|null = null;
  private smoothingAlpha = 0.6; // higher = more responsive, lower = smoother

  private async ensureHands() {
    if (this.handLandmarkerReady || this.handsReady) return;
    if (!this.videoEl) return;
    // Try to load MediaPipe Tasks HandLandmarker first (ESM via CDN)
    try {
      // @ts-ignore dynamic CDN import
      const tasks = await import('https://esm.sh/@mediapipe/tasks-vision@0.10.0');
      const vision = await tasks.FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm'
      );
      this.handLandmarker = await tasks.HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        },
        numHands: 1,
        runningMode: 'VIDEO',
      });
      this.handLandmarkerReady = true;
      return;
    } catch (e) {
      // continue to legacy fallback
      console.warn('HandLandmarker unavailable, falling back to legacy Hands', e);
    }

    // Fallback: legacy MediaPipe Hands if present on window
    // @ts-expect-error media pipe globals
    const Hands = (window as any).Hands;
    if (!Hands) return;
    this.hands = new Hands({
      locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });
    this.hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.7,
    });
    this.hands.onResults((res: any) => this.onLegacyHandsResults(res));
    this.handsReady = true;
  }

  private async loop() {
    await this.ensureHands();
    if (this.videoEl && this.cameraRunning) {
      try {
        if (this.handLandmarkerReady && this.handLandmarker) {
          const ts = performance.now();
          const res = this.handLandmarker.detectForVideo(this.videoEl, ts);
          this.onTasksHandsResults(res);
        } else if (this.handsReady && this.hands) {
          await this.hands.send({ image: this.videoEl });
        }
      } catch {}
    }
    // Safety: if tracking stalls, ensure any sustained piano note is released
    const nowTs = performance.now();
    if (this.pinchActiveKeyIndex !== null && nowTs - this.lastHandsTs > 400) {
      this.handlePianoPinch(false, null);
      this.pinchDown = false;
    }
    // If mediapipe not available, just keep trying in case scripts load later.
    requestAnimationFrame(() => this.loop());
  }

  private onLegacyHandsResults(res: any) {
    this.lastHandsTs = performance.now();
    const ctx = this.overlayCtx;
    const canvas = this.overlayEl;
    if (!ctx || !canvas) return;

    // Clear overlay
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw piano banner every frame
    this.drawPianoOverlay(ctx);

    const landmarks = res.multiHandLandmarks?.[0];
    if (!landmarks) {
      this.drawSelectionOverlay(ctx);
      // Ensure any sustained piano note is released if tracking drops
      this.handlePianoPinch(false, null);
      this.resetTrackingIfInactive();
      return;
    }

    // Normalize to overlay canvas coordinates
    const hostRect = this.getBoundingClientRect();
    const toViewport = (pt: { x: number; y: number }) => ({
      x: hostRect.left + (1 - pt.x) * hostRect.width, // mirror to match video mirror
      y: hostRect.top + pt.y * hostRect.height,
    });

    // Thumb tip (4), Index tip (8)
    const thumbV = toViewport(landmarks[4]);
    const indexV = toViewport(landmarks[8]);

    // Apply smoothing (legacy path)
    const smooth = (prev: {x:number;y:number}|null, curr: {x:number;y:number}) =>
      prev ? ({ x: prev.x + this.smoothingAlpha*(curr.x - prev.x), y: prev.y + this.smoothingAlpha*(curr.y - prev.y) }) : curr;
    this.smoothThumb = smooth(this.smoothThumb, thumbV);
    this.smoothIndex = smooth(this.smoothIndex, indexV);

    // Draw fingertips
    ctx.fillStyle = '#00e5ff';
    ctx.beginPath();
    // Draw fingertip markers in canvas space
    const toCanvas = (p: {x:number;y:number}) => ({ x: p.x - hostRect.left, y: p.y - hostRect.top });
    const thumb = toCanvas(this.smoothThumb);
    const index = toCanvas(this.smoothIndex);
    ctx.arc(thumb.x, thumb.y, 6, 0, Math.PI * 2);
    ctx.arc(index.x, index.y, 6, 0, Math.PI * 2);
    ctx.fill();

    const pinchDist = Math.hypot(this.smoothIndex.x - this.smoothThumb.x, this.smoothIndex.y - this.smoothThumb.y);
    const pinch = pinchDist < Math.max(30, hostRect.width * 0.03);
    const pinchPointViewport = { x: (this.smoothIndex.x + this.smoothThumb.x) / 2, y: (this.smoothIndex.y + this.smoothThumb.y) / 2 };
    const pinchPoint = toCanvas(pinchPointViewport);

    const nowTs = performance.now();
    const HOLD_MS = 450;
    const ANGLE_VALUE_PER_RAD = 0.5; // change in value per radian rotated

    // Determine hand orientation angle from wrist->index MCP vector
    const handAngle = (() => {
      // landmarks 0=wrist, 5=index MCP
      const wrist = toViewport(landmarks[0]);
      const idxMcp = toViewport(landmarks[5]);
      return Math.atan2(idxMcp.y - wrist.y, idxMcp.x - wrist.x);
    })();

    if (pinch) {
      if (!this.pinchDown) {
        // pinch just started
        this.pinchStartTs = nowTs;
        // If pinching the play/pause button, toggle and skip other selections
        const pp = this.renderRoot.querySelector('play-pause-button') as HTMLElement | null;
        if (pp) {
          const r = pp.getBoundingClientRect();
          if (
            pinchPointViewport.x >= r.left && pinchPointViewport.x <= r.right &&
            pinchPointViewport.y >= r.top && pinchPointViewport.y <= r.bottom
          ) {
            this.playPause();
            // Avoid interpreting this pinch for instruments/knobs
            this.candidatePromptId = null;
            this.selectedPromptId = null;
            // Still allow piano sustain logic to run separately
          }
        }
        // First try instrument selection; if close, select and don't set dial
        const nearIns = this.findNearestInstrument(pinchPointViewport.x, pinchPointViewport.y);
        if (nearIns && nearIns.dist < 90) {
          this.selectedInstrument = nearIns.index;
          // small visual feedback by drawing overlay later
          this.candidatePromptId = null;
          this.selectedPromptId = null;
        } else {
          const near = this.findNearestDial(pinchPointViewport.x, pinchPointViewport.y);
          this.candidatePromptId = (near && near.dist < 90) ? near.promptId : null;
          this.selectedPromptId = this.candidatePromptId;
        }
      } else {
        // pinch continued
        if (!this.activePromptId && this.pinchStartTs && this.candidatePromptId && nowTs - this.pinchStartTs >= HOLD_MS) {
          // activate selected dial
          this.activePromptId = this.candidatePromptId;
          this.rotationStartAngle = handAngle;
          this.pinchStartY = pinchPointViewport.y;
          const p = this.prompts.get(this.activePromptId);
          const base = p ? p.weight : 0;
          this.baseWeight = base;
          const limit = 2/3; // one-third of total range (2)
          this.minWeightAllowed = Math.max(0, base - limit);
          this.maxWeightAllowed = Math.min(2, base + limit);
        }
      }

      // While active, update weight based on rotation and vertical movement
      if (this.activePromptId && this.rotationStartAngle !== null && this.baseWeight !== null) {
        let delta = handAngle - this.rotationStartAngle;
        // normalize to [-pi, pi]
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        const rotationComponent = delta * ANGLE_VALUE_PER_RAD;
        // Vertical component: moving up increases, down decreases
        const verticalPx = (this.pinchStartY !== null) ? (this.pinchStartY - pinchPointViewport.y) : 0; // up -> positive
        const hostRect = this.getBoundingClientRect();
        const VALUE_PER_PX = 2 / Math.max(200, hostRect.height * 0.4); // move ~40% height to sweep full range
        const verticalComponent = verticalPx * VALUE_PER_PX;
        const proposed = this.baseWeight + rotationComponent + verticalComponent;
        const clamped = Math.max(this.minWeightAllowed!, Math.min(this.maxWeightAllowed!, proposed));
        this.setPromptWeight(this.activePromptId, clamped);
      }
    } else {
      // pinch released
      this.pinchStartTs = null;
      this.candidatePromptId = null;
      this.selectedPromptId = null;
      this.activePromptId = null;
      this.rotationStartAngle = null;
      this.baseWeight = null;
      this.minWeightAllowed = null;
      this.maxWeightAllowed = null;
      this.pinchStartY = null;
    }
    this.pinchDown = pinch;

    // Draw highlight if active
    this.drawSelectionOverlay(ctx, undefined, 0);

    // Piano key press detection now requires a two-finger pinch over a key
    this.handlePianoPinch(this.pinchDown, pinchPoint);
  }

  // New: Tasks HandLandmarker path
  private onTasksHandsResults(res: any) {
    this.lastHandsTs = performance.now();
    const ctx = this.overlayCtx;
    const canvas = this.overlayEl;
    if (!ctx || !canvas) return;

    // Clear overlay and draw piano
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.drawPianoOverlay(ctx);

    const landmarks = res?.landmarks?.[0];
    if (!landmarks) {
      this.drawSelectionOverlay(ctx);
      this.handlePianoPinch(false, null);
      this.resetTrackingIfInactive();
      return;
    }

    const hostRect = this.getBoundingClientRect();
    const toViewport = (pt: { x: number; y: number }) => ({
      x: hostRect.left + (1 - pt.x) * hostRect.width, // mirror to match video mirror
      y: hostRect.top + pt.y * hostRect.height,
    });

    const thumbV = toViewport(landmarks[4]);
    const indexV = toViewport(landmarks[8]);

    // Smoothing
    const smooth = (prev: {x:number;y:number}|null, curr: {x:number;y:number}) =>
      prev ? ({ x: prev.x + this.smoothingAlpha*(curr.x - prev.x), y: prev.y + this.smoothingAlpha*(curr.y - prev.y) }) : curr;
    this.smoothThumb = smooth(this.smoothThumb, thumbV);
    this.smoothIndex = smooth(this.smoothIndex, indexV);

    // Draw smoothed fingertips
    const toCanvas = (p: {x:number;y:number}) => ({ x: p.x - hostRect.left, y: p.y - hostRect.top });
    const thumb = toCanvas(this.smoothThumb);
    const index = toCanvas(this.smoothIndex);
    ctx.fillStyle = '#00e5ff';
    ctx.beginPath();
    ctx.arc(thumb.x, thumb.y, 6, 0, Math.PI * 2);
    ctx.arc(index.x, index.y, 6, 0, Math.PI * 2);
    ctx.fill();

    const pinchDist = Math.hypot(this.smoothIndex.x - this.smoothThumb.x, this.smoothIndex.y - this.smoothThumb.y);
    const pinch = pinchDist < Math.max(30, hostRect.width * 0.03);
    const pinchPointViewport = { x: (this.smoothIndex.x + this.smoothThumb.x) / 2, y: (this.smoothIndex.y + this.smoothThumb.y) / 2 };
    const pinchPoint = toCanvas(pinchPointViewport);

    const nowTs = performance.now();
    const HOLD_MS = 450;
    const ANGLE_VALUE_PER_RAD = 0.5;

    // Orientation from wrist->index MCP (0,5)
    const handAngle = (() => {
      const wrist = toViewport(landmarks[0]);
      const idxMcp = toViewport(landmarks[5]);
      return Math.atan2(idxMcp.y - wrist.y, idxMcp.x - wrist.x);
    })();

    if (pinch) {
      if (!this.pinchDown) {
        this.pinchStartTs = nowTs;
        const pp = this.renderRoot.querySelector('play-pause-button') as HTMLElement | null;
        if (pp) {
          const r = pp.getBoundingClientRect();
          if (pinchPointViewport.x >= r.left && pinchPointViewport.x <= r.right && pinchPointViewport.y >= r.top && pinchPointViewport.y <= r.bottom) {
            this.playPause();
            this.candidatePromptId = null;
            this.selectedPromptId = null;
          }
        }
        const nearIns = this.findNearestInstrument(pinchPointViewport.x, pinchPointViewport.y);
        if (nearIns && nearIns.dist < 90) {
          this.selectedInstrument = nearIns.index;
          this.candidatePromptId = null;
          this.selectedPromptId = null;
        } else {
          const near = this.findNearestDial(pinchPointViewport.x, pinchPointViewport.y);
          this.candidatePromptId = (near && near.dist < 90) ? near.promptId : null;
          this.selectedPromptId = this.candidatePromptId;
        }
      } else {
        if (!this.activePromptId && this.pinchStartTs && this.candidatePromptId && nowTs - this.pinchStartTs >= HOLD_MS) {
          this.activePromptId = this.candidatePromptId;
          this.rotationStartAngle = handAngle;
          this.pinchStartY = pinchPointViewport.y;
          const p = this.prompts.get(this.activePromptId);
          const base = p ? p.weight : 0;
          this.baseWeight = base;
          const limit = 2/3;
          this.minWeightAllowed = Math.max(0, base - limit);
          this.maxWeightAllowed = Math.min(2, base + limit);
        }
      }

    if (this.activePromptId && this.rotationStartAngle !== null && this.baseWeight !== null) {
      let delta = handAngle - this.rotationStartAngle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      const rotationComponent = delta * ANGLE_VALUE_PER_RAD;
      const verticalPx = (this.pinchStartY !== null) ? (this.pinchStartY - pinchPointViewport.y) : 0;
      const hostRect2 = this.getBoundingClientRect();
      const VALUE_PER_PX = 2 / Math.max(200, hostRect2.height * 0.4);
      const verticalComponent = verticalPx * VALUE_PER_PX;
      const proposed = this.baseWeight + rotationComponent + verticalComponent;
      const clamped = Math.max(this.minWeightAllowed!, Math.min(this.maxWeightAllowed!, proposed));
      this.setPromptWeight(this.activePromptId, clamped);
    }
    } else {
      this.pinchStartTs = null;
      this.candidatePromptId = null;
      this.selectedPromptId = null;
      this.activePromptId = null;
      this.rotationStartAngle = null;
      this.baseWeight = null;
      this.minWeightAllowed = null;
      this.maxWeightAllowed = null;
      this.pinchStartY = null;
    }
    this.pinchDown = pinch;

    this.drawSelectionOverlay(ctx, undefined, 0);
    this.handlePianoPinch(this.pinchDown, pinchPoint);
  }

  private drawSelectionOverlay(ctx: CanvasRenderingContext2D) {
    const targetId = this.activePromptId || this.selectedPromptId;
    if (!targetId) return;
    const dial = this.getDialCenter(targetId);
    if (!dial) return;
    const r = Math.max(35, Math.min(dial.radius, 60));
    ctx.save();
    // Base ring
    ctx.strokeStyle = this.activePromptId ? '#ffe600' : '#8888ff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(dial.x, dial.y, r, 0, Math.PI * 2);
    ctx.stroke();
    // If active, draw a pointer indicator
    if (this.activePromptId && this.rotationStartAngle !== null) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 5;
      // pointer angle approximated from current weight relative to base within [0,2]
      const p = this.prompts.get(this.activePromptId);
      const curr = p ? p.weight : 0;
      const base = this.baseWeight ?? curr;
      const ANGLE_VALUE_PER_RAD = 0.5;
      const deltaAngle = (curr - base) / ANGLE_VALUE_PER_RAD; // radians
      const angle = (-Math.PI/2) + deltaAngle; // start at top, rotate with delta
      const x2 = dial.x + (r + 8) * Math.cos(angle);
      const y2 = dial.y + (r + 8) * Math.sin(angle);
      ctx.beginPath();
      ctx.moveTo(dial.x, dial.y);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ====== Piano banner (top, ~80% transparent) ======
  private computePianoKeys(hostRect: DOMRect) {
    const bannerHeight = Math.max(60, hostRect.height * 0.14); // small banner
    const x = 0;
    const y = 0;
    const w = hostRect.width;
    const h = bannerHeight;
    // Expand to 23 keys (add 15 more than original 8)
    const WHITE_KEY_STEPS = [2, 2, 1, 2, 2, 2, 1]; // diatonic steps in semitones (C major)
    const startNote = 60; // C4
    const totalKeys = 23; // 8 original + 15 more
    const notes: number[] = [startNote];
    while (notes.length < totalKeys) {
      const idx = (notes.length - 1) % WHITE_KEY_STEPS.length;
      notes.push(notes[notes.length - 1] + WHITE_KEY_STEPS[idx]);
    }
    const keyW = w / notes.length;
    this.pianoKeys = notes.map((n, i) => ({ x: i * keyW, y, w: keyW, h, note: n }));
  }

  private drawPianoOverlay(ctx: CanvasRenderingContext2D) {
    const canvas = this.overlayEl; if (!canvas) return;
    const hostRect = this.getBoundingClientRect();
    if (this.pianoKeys.length === 0 || Math.abs(this.pianoKeys[0].w * this.pianoKeys.length - hostRect.width) > 1) {
      this.computePianoKeys(hostRect);
    }
    // Background banner (80% transparent -> opacity 0.2)
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, Math.max(60, canvas.height * 0.14));
    ctx.restore();
    // Keys
    for (let i = 0; i < this.pianoKeys.length; i++) {
      const k = this.pianoKeys[i];
      const isActive = this.pinchActiveKeyIndex === i;
      ctx.fillStyle = isActive ? '#ffe600' : '#ffffff';
      ctx.globalAlpha = isActive ? 0.9 : 0.6;
      ctx.fillRect(k.x, k.y, k.w - 1, k.h - 1);
    }
    ctx.globalAlpha = 1;
  }

  private hitTestPiano(x: number, y: number): number | null {
    for (let i = 0; i < this.pianoKeys.length; i++) {
      const k = this.pianoKeys[i];
      if (x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h) return i;
    }
    return null;
  }

  // Removed touch-based piano handling; pinch-only is implemented below

  // New: handle piano using two-finger pinch only
  private handlePianoPinch(isPinching: boolean, pinchPoint: {x: number; y: number} | null) {
    const hostRect = this.getBoundingClientRect();
    if (!isPinching || !pinchPoint) {
      if (this.pinchActiveKeyIndex !== null) {
        try { this.noteOff('pinch'); } catch (e) { console.warn('noteOff pinch release error', e); }
        this.pinchActiveKeyIndex = null;
      }
      return;
    }
    const keyIndex = this.hitTestPiano(pinchPoint.x, pinchPoint.y);
    const prev = this.pinchActiveKeyIndex;
    if (keyIndex !== null && keyIndex !== prev) {
      if (prev !== null) { try { this.noteOff('pinch'); } catch (e) { console.warn('noteOff transition error', e); } }
      this.noteOn('pinch', this.pianoKeys[keyIndex].note);
      this.pinchActiveKeyIndex = keyIndex;
    } else if (keyIndex === null && prev !== null) {
      try { this.noteOff('pinch'); } catch (e) { console.warn('noteOff leave-key error', e); }
      this.pinchActiveKeyIndex = null;
    }
  }

  private noteOn(id: string, midiNote: number) {
    this.ensureSynth();
    if (!this.audioCtx) return;
    const insKey = this.instruments[this.selectedInstrument]?.key || 'piano';
    const noteAdj = insKey === 'bass' ? midiNote - 12 : midiNote;
    const freq = 440 * Math.pow(2, (noteAdj - 69) / 12);
    const now = this.audioCtx.currentTime;
    const o = this.audioCtx.createOscillator();
    const g = this.audioCtx.createGain();
    const filter = this.audioCtx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 8000;
    switch (insKey) {
      case 'piano': o.type = 'triangle'; break;
      case 'guitar': o.type = 'sawtooth'; filter.frequency.value = 3500; break;
      case 'sitar': o.type = 'sawtooth'; filter.type = 'bandpass'; filter.frequency.value = 1200; break;
      case 'flute': o.type = 'sine'; filter.frequency.value = 6000; break;
      case 'violin': o.type = 'sawtooth'; filter.frequency.value = 4000; break;
      case 'bass': o.type = 'square'; filter.frequency.value = 1200; break;
      case 'drums':
        // Drums: quick one-shot based on key position
        this.playDrum((['thumb','index','middle','ring','pinky'] as const)[Math.floor(Math.random()*5)]);
        return;
      default: o.type = 'sine';
    }
    o.frequency.value = freq;
    o.connect(g); g.connect(filter); filter.connect(this.audioCtx.destination);
    g.gain.setValueAtTime(0, now);
    const attack = insKey === 'violin' ? 0.05 : insKey === 'flute' ? 0.03 : 0.01;
    g.gain.linearRampToValueAtTime(0.35, now + attack);
    this.activeVoices[id] = { o, g, filter };
    // Debug: track active voice creation
    // console.debug('noteOn', { id, midiNote, insKey, freq });
    o.start();
  }

  private noteOff(id: string) {
    if (!this.audioCtx) return;
    const v = this.activeVoices[id];
    if (!v) return;
    const now = this.audioCtx.currentTime;
    try {
      if ((v as any).g && (v as any).g.gain) {
        (v as any).g.gain.setValueAtTime((v as any).g.gain.value, now);
        (v as any).g.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
      }
      if ((v as any).o && typeof (v as any).o.stop === 'function') {
        (v as any).o.stop(now + 0.1);
      }
    } catch (e) {
      console.warn('noteOff error for id', id, e);
    }
    delete this.activeVoices[id];
  }

  private ensureSynth() {
    if (!this.audioCtx) {
      try {
        this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      } catch {}
    }
    if (!this.audioCtx) return;
    if (!this.instrumentNodes) this.instrumentNodes = {};
  }

  private playDrum(finger: 'thumb'|'index'|'middle'|'ring'|'pinky') {
    if (!this.audioCtx) return;
    const now = this.audioCtx.currentTime;
    const g = this.audioCtx.createGain();
    g.connect(this.audioCtx.destination);
    const peak = 0.5;
    const end = now + 0.3;
    g.gain.setValueAtTime(peak, now);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    if (finger === 'thumb') {
      // kick: sine burst with pitch drop
      const o = this.audioCtx.createOscillator();
      o.type = 'sine';
      o.connect(g);
      const startF = 120; const endF = 45;
      o.frequency.setValueAtTime(startF, now);
      o.frequency.exponentialRampToValueAtTime(endF, end);
      o.start(now); o.stop(end);
    } else if (finger === 'index' || finger === 'middle') {
      // snare: noise + bandpass
      const buffer = this.audioCtx.createBuffer(1, this.audioCtx.sampleRate * 0.2, this.audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = this.audioCtx.createBufferSource();
      const bp = this.audioCtx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      src.buffer = buffer;
      src.connect(bp); bp.connect(g);
      src.start(now); src.stop(end);
    } else {
      // hihat: highpass noise
      const buffer = this.audioCtx.createBuffer(1, this.audioCtx.sampleRate * 0.1, this.audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = this.audioCtx.createBufferSource();
      const hp = this.audioCtx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 6000;
      src.buffer = buffer;
      src.connect(hp); hp.connect(g);
      src.start(now); src.stop(now + 0.1);
    }
  }

  private resetTrackingIfInactive() {
    if (!this.pinchDown) {
      this.selectedPromptId = null;
      this.activePromptId = null;
    }
  }

  // commitActiveDial removed in rotation mode

  private setPromptWeight(promptId: string, weight: number) {
    const p = this.prompts.get(promptId);
    if (!p) return;
    const updated = { ...p, weight } as Prompt;
    const newMap = new Map(this.prompts);
    newMap.set(promptId, updated);
    this.prompts = newMap;
    this.requestUpdate();
    this.dispatchEvent(new CustomEvent('prompts-changed', { detail: this.prompts }));
  }

  private getAllPromptControllers(): Array<{el: Element, id: string}> {
    const nodes = Array.from(this.renderRoot.querySelectorAll('prompt-controller')) as Array<HTMLElement & {promptId?: string}>;
    return nodes.map((el) => ({ el, id: (el as any).promptId as string }));
  }

  private getDialCenter(promptId: string): { x: number; y: number; radius: number } | null {
    const pcs = this.getAllPromptControllers();
    const match = pcs.find(p => p.id === promptId);
    if (!match) return null;
    const pcEl = match.el as HTMLElement;
    const weightKnob = (pcEl.shadowRoot?.querySelector('weight-knob') as HTMLElement) || pcEl;
    const rect = weightKnob.getBoundingClientRect();
    const hostRect = this.getBoundingClientRect();
    return {
      x: rect.left - hostRect.left + rect.width/2,
      y: rect.top - hostRect.top + rect.height/2,
      radius: Math.min(rect.width, rect.height)/2,
    };
  }

  private findNearestDial(x: number, y: number): { promptId: string; dist: number } | null {
    const pcs = this.getAllPromptControllers();
    if (pcs.length === 0) return null;
    let best: { promptId: string; dist: number } | null = null;
    for (const p of pcs) {
      const weightKnob = ((p.el as HTMLElement).shadowRoot?.querySelector('weight-knob') as HTMLElement) || (p.el as HTMLElement);
      const rect = weightKnob.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const d = Math.hypot(x - cx, y - cy);
      if (!best || d < best.dist) best = { promptId: p.id, dist: d };
    }
    return best;
  }

  private findNearestInstrument(x: number, y: number): { index: number; dist: number } | null {
    const panel = this.renderRoot.querySelector('#instrument-panel') as HTMLElement | null;
    if (!panel) return null;
    const items = Array.from(panel.querySelectorAll('.instrument')) as HTMLElement[];
    let best: { index: number; dist: number } | null = null;
    items.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = Math.hypot(x - cx, y - cy);
      if (!best || d < best.dist) best = { index: i, dist: d };
    });
    return best;
  }
}
