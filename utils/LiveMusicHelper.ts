/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import type { PlaybackState, Prompt } from '../types';
import type { AudioChunk, GoogleGenAI, LiveMusicFilteredPrompt, LiveMusicServerMessage, LiveMusicSession } from '@google/genai';
import { decode, decodeAudioData } from './audio';
import { throttle } from './throttle';

export class LiveMusicHelper extends EventTarget {

  // Create a fresh client on demand so ephemeral tokens don't expire while idle
  private aiFactory: () => Promise<GoogleGenAI>;
  private model: string;

  private session: LiveMusicSession | null = null;
  private sessionPromise: Promise<LiveMusicSession> | null = null;

  private connectionError = true;

  private filteredPrompts = new Set<string>();
  private nextStartTime = 0;
  private bufferTime = 2;

  public readonly audioContext: AudioContext;
  public extraDestination: AudioNode | null = null;

  private outputNode: GainNode;
  private playbackState: PlaybackState = 'stopped';

  private prompts: Map<string, Prompt>;

  private sessionId: string | null = null;

  private log(...args: any[]) {
    // Centralized logging with a consistent tag
    // eslint-disable-next-line no-console
    console.log('[LiveMusic]', ...args);
  }

  constructor(aiFactory: () => Promise<GoogleGenAI>, model: string) {
    super();
    this.aiFactory = aiFactory;
    this.model = model;
    this.prompts = new Map();
    this.audioContext = new AudioContext({ sampleRate: 48000 });
    this.outputNode = this.audioContext.createGain();
    this.log('AudioContext created', {
      sampleRate: this.audioContext.sampleRate,
      userAgent: navigator.userAgent,
    });
  }

  private getSession(): Promise<LiveMusicSession> {
    if (!this.sessionPromise) this.sessionPromise = this.connect();
    return this.sessionPromise;
  }

  private async connect(): Promise<LiveMusicSession> {
    // Get a fresh client to ensure token validity at connection time
    const ai = await this.aiFactory();
    this.sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.log('Connecting live session…', {
      sessionId: this.sessionId,
      model: this.model,
      online: navigator.onLine,
      visibility: document.visibilityState,
    });
    this.sessionPromise = ai.live.music.connect({
      model: this.model,
      callbacks: {
        onmessage: async (e: LiveMusicServerMessage) => {
          if (e.setupComplete) {
            this.connectionError = false;
            this.log('Live session setup complete', { sessionId: this.sessionId });
          }
          if (e.filteredPrompt) {
            this.filteredPrompts = new Set([...this.filteredPrompts, e.filteredPrompt.text!])
            this.dispatchEvent(new CustomEvent<LiveMusicFilteredPrompt>('filtered-prompt', { detail: e.filteredPrompt }));
            this.log('Filtered prompt received', {
              sessionId: this.sessionId,
              text: e.filteredPrompt.text,
              reason: e.filteredPrompt.filteredReason,
            });
          }
          if (e.serverContent?.audioChunks) {
            try {
            await this.processAudioChunks(e.serverContent.audioChunks);
            } catch (err) {
              this.log('Error processing audio chunks', { sessionId: this.sessionId, err });
            }
          }
        },
        onerror: (err?: any) => {
          this.log('WebSocket error', { sessionId: this.sessionId, err });
          this.handleDisconnect();
          this.dispatchEvent(new CustomEvent('error', { detail: 'Connection error, please restart audio.' }));
        },
        onclose: () => {
          this.log('WebSocket closed', { sessionId: this.sessionId });
          this.handleDisconnect();
          this.dispatchEvent(new CustomEvent('error', { detail: 'Connection closed, please restart audio.' }));
        },
      },
    });
    return this.sessionPromise;
  }

  private setPlaybackState(state: PlaybackState) {
    this.playbackState = state;
    this.dispatchEvent(new CustomEvent('playback-state-changed', { detail: state }));
  }

  private async processAudioChunks(audioChunks: AudioChunk[]) {
    if (this.playbackState === 'paused' || this.playbackState === 'stopped') return;
    this.log('Audio chunk received', {
      sessionId: this.sessionId,
      chunks: audioChunks.length,
      nextStartTime: this.nextStartTime,
      currentTime: this.audioContext.currentTime,
    });
    const audioBuffer = await decodeAudioData(
      decode(audioChunks[0].data!),
      this.audioContext,
      48000,
      2,
    );
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.outputNode);
    if (this.nextStartTime === 0) {
      this.nextStartTime = this.audioContext.currentTime + this.bufferTime;
      setTimeout(() => {
        this.setPlaybackState('playing');
      }, this.bufferTime * 1000);
    }
    if (this.nextStartTime < this.audioContext.currentTime) {
      this.setPlaybackState('loading');
      this.nextStartTime = 0;
      return;
    }
    source.start(this.nextStartTime);
    this.nextStartTime += audioBuffer.duration;
  }

  public get activePrompts() {
    return Array.from(this.prompts.values())
      .filter((p) => {
        return !this.filteredPrompts.has(p.text) && p.weight !== 0;
      })
  }

  public readonly setWeightedPrompts = throttle(async (prompts: Map<string, Prompt>) => {
    this.prompts = prompts;

    if (this.activePrompts.length === 0) {
      this.dispatchEvent(new CustomEvent('error', { detail: 'There needs to be one active prompt to play.' }));
      this.pause();
      return;
    }

    // store the prompts to set later if we haven't connected yet
    // there should be a user interaction before calling setWeightedPrompts
    if (!this.session) return;

    try {
      await this.session.setWeightedPrompts({
        weightedPrompts: this.activePrompts,
      });
      this.log('Updated weighted prompts', { sessionId: this.sessionId, count: this.activePrompts.length });
    } catch (e: any) {
      this.log('Error setting weighted prompts', { sessionId: this.sessionId, err: e });
      this.dispatchEvent(new CustomEvent('error', { detail: e.message }));
      this.pause();
    }
  }, 200);

  public async play() {
    this.log('Play requested', { sessionId: this.sessionId, state: this.playbackState });
    this.setPlaybackState('loading');
    this.session = await this.getSession();
    await this.setWeightedPrompts(this.prompts);
    this.audioContext.resume();
    try {
      this.session.play();
      this.log('Sent play to session', { sessionId: this.sessionId });
    } catch (err) {
      this.log('Error sending play to session', { sessionId: this.sessionId, err });
    }
    this.outputNode.connect(this.audioContext.destination);
    if (this.extraDestination) this.outputNode.connect(this.extraDestination);
    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.1);
  }

  public pause() {
    this.log('Pause requested', { sessionId: this.sessionId, state: this.playbackState });
    try { if (this.session) { this.session.pause(); this.log('Sent pause to session', { sessionId: this.sessionId }); } } catch (err) { this.log('Pause send error', { sessionId: this.sessionId, err }); }
    this.setPlaybackState('paused');
    this.outputNode.gain.setValueAtTime(1, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1);
    this.nextStartTime = 0;
    this.outputNode = this.audioContext.createGain();
  }

  public stop() {
    this.log('Stop requested', { sessionId: this.sessionId, state: this.playbackState });
    try { if (this.session) { this.session.stop(); this.log('Sent stop to session', { sessionId: this.sessionId }); } } catch (err) { this.log('Stop send error', { sessionId: this.sessionId, err }); }
    this.setPlaybackState('stopped');
    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.1);
    this.nextStartTime = 0;
    this.session = null;
    this.sessionPromise = null;
  }

  private handleDisconnect() {
    this.connectionError = true;
    // Do NOT send any playback controls here: WS may already be closed.
    this.log('Handle disconnect', { sessionId: this.sessionId });
    this.setPlaybackState('stopped');
    try {
      this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime);
      this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.1);
    } catch {}
    this.nextStartTime = 0;
    this.session = null;
    this.sessionPromise = null;
  }

  public async playPause() {
    switch (this.playbackState) {
      case 'playing':
        return this.pause();
      case 'paused':
      case 'stopped':
        return this.play();
      case 'loading':
        return this.stop();
    }
  }

}
