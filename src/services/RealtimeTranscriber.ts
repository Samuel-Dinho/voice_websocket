
// src/services/RealtimeTranscriber.ts
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { Writable, PassThrough } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import ffmpegPath from 'ffmpeg-static'; // Use ffmpeg-static for a portable ffmpeg path

// Helper para encontrar o caminho do script Python
const SCRIPT_PATH = path.join(process.cwd(), 'src', 'scripts', 'python', 'run_whisper.py');

interface TranscriberOptions {
  language: string;
  model: string;
  targetLanguage: string; // Added targetLanguage
  onTranscriptionReady: (fullTranscription: string, targetLanguage: string) => void;
  onError: (error: Error) => void;
}

/**
 * Manages a real-time audio transcription session using a persistent FFmpeg process
 * to convert incoming audio chunks (expected to be WebM/Opus) to raw PCM,
 * and then periodically transcribes windows of this PCM audio using a Whisper Python script.
 */
export class RealtimeTranscriber {
  private options: TranscriberOptions;
  private ffmpegProcess: ChildProcessWithoutNullStreams | null = null;
  private audioInputWriter: Writable | null = null; // This will be ffmpeg's stdin
  private pcmAudioBuffer: Buffer = Buffer.alloc(0);
  private whisperInterval: NodeJS.Timeout | null = null;
  private lastFullTranscription = '';
  private isProcessingWhisper = false;
  private uniqueId: string;


  // Constants for the sliding window
  private static readonly WHISPER_INTERVAL_MS = 2000; // Process with Whisper every X ms
  private static readonly WHISPER_WINDOW_SECONDS = 7;   // Use the latest Y seconds of PCM audio for Whisper

  constructor(options: TranscriberOptions) {
    this.options = options;
    this.uniqueId = Date.now().toString() + Math.random().toString(36).substring(2,7);
    console.log(`[RealtimeTranscriber-${this.uniqueId}] Instantiated. Lang: ${options.language}, Model: ${options.model}, Target: ${options.targetLanguage}`);
  }

  public start() {
    console.log(`[RealtimeTranscriber-${this.uniqueId}] Starting transcription session...`);
    
    if (!ffmpegPath) {
        const errMsg = "[RealtimeTranscriber] ffmpeg-static path is null. Cannot start ffmpeg.";
        console.error(errMsg);
        this.options.onError(new Error(errMsg));
        return;
    }

    const ffmpegArgs = [
      '-i', '-',              // Input from stdin
      '-f', 'webm',           // Assume input format is webm (MediaRecorder typically outputs this with Opus)
      '-acodec', 'pcm_s16le', // Output audio codec: PCM 16-bit little-endian
      '-ar', '16000',         // Output audio sample rate: 16kHz (common for STT)
      '-ac', '1',             // Output audio channels: 1 (mono)
      '-f', 's16le',          // Output container format: raw s16le PCM
      'pipe:1'                // Output to stdout
    ];

    try {
      this.ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);
      console.log(`[RealtimeTranscriber-${this.uniqueId}] FFmpeg process spawned with command: ${ffmpegPath} ${ffmpegArgs.join(' ')}`);

      this.audioInputWriter = this.ffmpegProcess.stdin;

      this.ffmpegProcess.stdout.on('data', (chunk: Buffer) => {
        this.pcmAudioBuffer = Buffer.concat([this.pcmAudioBuffer, chunk]);
        // Optional: Trim buffer if it gets too large, though WHISPER_WINDOW_SECONDS should manage active part
        const maxBufferSize = (RealtimeTranscriber.WHISPER_WINDOW_SECONDS + 5) * 16000 * 2; // немного больше окна
        if (this.pcmAudioBuffer.length > maxBufferSize) {
            this.pcmAudioBuffer = this.pcmAudioBuffer.slice(-maxBufferSize);
        }
      });

      this.ffmpegProcess.stderr.on('data', (data: Buffer) => {
        console.warn(`[FFmpeg-${this.uniqueId}] stderr: ${data.toString()}`);
      });

      this.ffmpegProcess.on('error', (err) => {
        console.error(`[FFmpeg-${this.uniqueId}] Error in process:`, err);
        this.options.onError(err);
        this.stop(); // Ensure cleanup on error
      });

      this.ffmpegProcess.on('close', (code) => {
        console.log(`[FFmpeg-${this.uniqueId}] process exited with code ${code}`);
        this.ffmpegProcess = null; // Mark as stopped
        // If stop wasn't called explicitly, this is an unexpected close.
        if (this.whisperInterval) { // Check if we were supposed to be running
            this.options.onError(new Error(`FFmpeg process closed unexpectedly with code ${code}`));
            this.stop();
        }
      });

      this.whisperInterval = setInterval(
        () => this.triggerWhisperProcessing(),
        RealtimeTranscriber.WHISPER_INTERVAL_MS
      );
      console.log(`[RealtimeTranscriber-${this.uniqueId}] Whisper processing interval set up.`);

    } catch (error: any) {
      console.error(`[RealtimeTranscriber-${this.uniqueId}] Failed to spawn FFmpeg:`, error);
      this.options.onError(error);
    }
  }

  public addAudioChunk(chunk: Buffer) {
    if (this.audioInputWriter && !this.audioInputWriter.destroyed) {
      try {
        this.audioInputWriter.write(chunk);
      } catch (error: any) {
         console.error(`[RealtimeTranscriber-${this.uniqueId}] Error writing chunk to FFmpeg stdin:`, error.message);
         // this.options.onError(error); // This might be too noisy
      }
    } else {
      // console.warn(`[RealtimeTranscriber-${this.uniqueId}] FFmpeg stdin not available or destroyed. Cannot write audio chunk.`);
    }
  }

  public stop() {
    console.log(`[RealtimeTranscriber-${this.uniqueId}] Stopping transcription session...`);
    if (this.whisperInterval) {
      clearInterval(this.whisperInterval);
      this.whisperInterval = null;
    }
    if (this.audioInputWriter && !this.audioInputWriter.destroyed) {
      this.audioInputWriter.end();
      this.audioInputWriter = null;
    }
    if (this.ffmpegProcess) {
      console.log(`[RealtimeTranscriber-${this.uniqueId}] Killing FFmpeg process.`);
      this.ffmpegProcess.kill('SIGTERM'); // More graceful
      // Set a timeout to forcefully kill if it doesn't exit
      setTimeout(() => {
        if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
          console.warn(`[RealtimeTranscriber-${this.uniqueId}] FFmpeg did not exit gracefully, sending SIGKILL.`);
          this.ffmpegProcess.kill('SIGKILL');
        }
      }, 2000); // 2 seconds grace period
      this.ffmpegProcess = null;
    }
    this.pcmAudioBuffer = Buffer.alloc(0);
    this.lastFullTranscription = '';
    this.isProcessingWhisper = false;
    console.log(`[RealtimeTranscriber-${this.uniqueId}] Session stopped and resources cleaned up.`);
  }

  private async triggerWhisperProcessing() {
    if (this.isProcessingWhisper || this.pcmAudioBuffer.length === 0) {
      return; // Avoid overlap or processing silence
    }

    this.isProcessingWhisper = true;

    const bytesPerSecondPCM = 16000 * 2; // 16kHz sample rate * 16-bit (2 bytes per sample)
    const windowBytes = RealtimeTranscriber.WHISPER_WINDOW_SECONDS * bytesPerSecondPCM;
    
    const pcmAudioSlice = this.pcmAudioBuffer.length > windowBytes 
        ? this.pcmAudioBuffer.slice(-windowBytes) 
        : Buffer.from(this.pcmAudioBuffer); // Use a copy

    if (pcmAudioSlice.length < bytesPerSecondPCM * 0.5) { // Need at least 0.5s of audio
        // console.log(`[RealtimeTranscriber-${this.uniqueId}] PCM audio slice too short (${pcmAudioSlice.length} bytes). Skipping Whisper.`);
        this.isProcessingWhisper = false;
        return;
    }

    let tempWavFilePath: string | null = null;
    try {
      const header = this.createWavHeader(pcmAudioSlice.length);
      const tempWavBuffer = Buffer.concat([header, pcmAudioSlice]);
      
      tempWavFilePath = path.join(os.tmpdir(), `rt_whisper_${this.uniqueId}_${Date.now()}.wav`);
      await fs.writeFile(tempWavFilePath, tempWavBuffer);

      // console.log(`[RealtimeTranscriber-${this.uniqueId}] Executing Whisper on ${tempWavFilePath} (${(tempWavBuffer.length / 1024).toFixed(2)} KB)`);
      const currentTranscriptionSegment = await this.executeWhisperScript(tempWavFilePath);
      
      // Basic logic to append or replace transcription based on overlap.
      // A more sophisticated diff/merge would be better for perfect continuity.
      if (currentTranscriptionSegment && currentTranscriptionSegment.trim() !== "") {
        // This simple logic tries to find if the new segment significantly overlaps or continues the old one.
        // It's not perfect and can lead to repetitions or gaps.
        // For true streaming STT, Whisper models with streaming support or more advanced segment joining is needed.
        // For now, we'll use a heuristic: if the new transcription contains a good part of the end of the old one,
        // or if the old one is short, we try to merge. Otherwise, we might just append or replace.
        
        let updatedTranscription = this.lastFullTranscription;
        const newText = currentTranscriptionSegment.trim();

        // Heuristic: if new text is very different or last transcription was short, just use new text.
        // This is a very naive approach to avoid massive duplication if Whisper re-transcribes a lot.
        // A proper solution would involve timestamped words from Whisper and segment alignment.
        if (!this.lastFullTranscription || this.lastFullTranscription.length < 10 || !newText.includes(this.lastFullTranscription.slice(-10))) {
            if (this.lastFullTranscription && !newText.startsWith(this.lastFullTranscription) && !this.lastFullTranscription.endsWith(newText)) {
                 updatedTranscription = (this.lastFullTranscription + " " + newText).trim();
            } else {
                 updatedTranscription = newText; // Or a smarter merge
            }
        } else {
             // Try to find overlap and append only new parts
            let overlapIndex = -1;
            for (let i = Math.min(15, this.lastFullTranscription.length, newText.length); i > 3; i--) {
                if (this.lastFullTranscription.endsWith(newText.substring(0, i))) {
                    overlapIndex = i;
                    break;
                }
            }
            if (overlapIndex !== -1) {
                updatedTranscription = this.lastFullTranscription + newText.substring(overlapIndex);
            } else {
                 updatedTranscription = (this.lastFullTranscription + " " + newText).trim();
            }
        }


        if (updatedTranscription !== this.lastFullTranscription) {
            // console.log(`[RealtimeTranscriber-${this.uniqueId}] New transcription: "${updatedTranscription.substring(0,50)}..." (Prev: "${this.lastFullTranscription.substring(0,50)}...")`);
            this.lastFullTranscription = updatedTranscription;
            this.options.onTranscriptionReady(this.lastFullTranscription, this.options.targetLanguage);
        } else {
            // console.log(`[RealtimeTranscriber-${this.uniqueId}] Transcription segment same as previous or resulted in no change: "${currentTranscriptionSegment.substring(0,50)}..."`);
        }
      }

    } catch (error: any) {
      console.error(`[RealtimeTranscriber-${this.uniqueId}] Error during Whisper processing cycle:`, error.message);
      this.options.onError(error);
    } finally {
      if (tempWavFilePath) {
        await fs.unlink(tempWavFilePath).catch(err => console.warn(`[RealtimeTranscriber-${this.uniqueId}] Failed to remove temp WAV file ${tempWavFilePath}:`, err.message));
      }
      this.isProcessingWhisper = false;
    }
  }

  private async executeWhisperScript(filePath: string): Promise<string> {
    const pythonExecutable = process.env.PYTHON_EXECUTABLE || 'python';
    const args = [SCRIPT_PATH, filePath, this.options.model, this.options.language];
    
    // console.log(`[RealtimeTranscriber-${this.uniqueId}] Spawning Python script: ${pythonExecutable} ${args.join(' ')}`);
    const child = spawn(pythonExecutable, args);
    let stdout = '';
    let stderr = '';

    // Set timeout for the Python script execution
    const scriptTimeout = setTimeout(() => {
        console.warn(`[RealtimeTranscriber-${this.uniqueId}] Python script execution timed out after 30s for ${filePath}. Killing process.`);
        child.kill('SIGKILL');
    }, 30000); // 30-second timeout

    for await (const chunk of child.stdout) {
      stdout += chunk;
    }
    for await (const chunk of child.stderr) {
      stderr += chunk;
    }
    
    clearTimeout(scriptTimeout); // Clear timeout if script finishes in time

    const exitCode = await new Promise<number | null>(resolve => child.on('close', resolve));

    if (stderr && !stderr.includes("UserWarning: 1Torch was not compiled with flash attention")) { // Log significant stderr
      console.warn(`[WhisperScript-${this.uniqueId}] stderr for ${filePath}: ${stderr.trim()}`);
    }

    if (exitCode !== 0) {
      const errorMsg = `Whisper script failed with exit code ${exitCode} for ${filePath}. Stderr: ${stderr.trim()}`;
      console.error(`[WhisperScript-${this.uniqueId}] ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    return stdout.trim();
  }

  private createWavHeader(dataLength: number): Buffer {
    const buffer = Buffer.alloc(44);
    const sampleRate = 16000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataLength, 4); // ChunkSize
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    buffer.writeUInt16LE(1, 20);  // AudioFormat (1 for PCM)
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataLength, 40); // Subchunk2Size
    return buffer;
  }
}
