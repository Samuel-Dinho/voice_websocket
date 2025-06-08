
'use server';
/**
 * @fileOverview This file defines a flow for transcribing audio by
 * calling an external Python script that uses Whisper.
 * The Python script now attempts to convert input audio to WAV using FFmpeg.
 *
 * THIS FLOW IS CURRENTLY NOT USED BY THE WEBSOCKET SERVER FOR REAL-TIME STREAMING.
 * The real-time STT is handled by the RealtimeTranscriber service.
 * This flow might be used for other non-streaming transcription tasks if needed.
 *
 * - transcribeAudio - A function that initiates the audio transcription flow.
 * - TranscribeAudioInput - The input type for the transcribeAudio function.
 * - TranscribeAudioOutput - The return type for the transcribeAudio function.
 */

import {z} from 'genkit';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile as execFileCallback } from 'child_process';
import util from 'util';

// Promisify execFile
const execFile = util.promisify(execFileCallback);

// Define Zod schemas for input and output
const TranscribeAudioInputSchema = z.object({
  audioDataUri: z
    .string()
    .describe(
      "The audio data to be transcribed, as a data URI. Expected format: 'data:<mimetype>;base64,<encoded_data>'."
    ),
  languageCode: z.string().optional().describe('The language of the audio. BCP-47 format (e.g., "en-US", "pt-BR", "auto"). This will be a hint for the STT model.'),
});
export type TranscribeAudioInput = z.infer<typeof TranscribeAudioInputSchema>;

const TranscribeAudioOutputSchema = z.object({
  transcribedText: z.string().describe('The transcribed text from the audio.'),
});
export type TranscribeAudioOutput = z.infer<
  typeof TranscribeAudioOutputSchema
>;

export async function transcribeAudio(
  input: TranscribeAudioInput
): Promise<TranscribeAudioOutput> {
  console.log(`[transcribeAudioFlow] Received request. Language hint: ${input.languageCode || 'auto'}.`);

  const { audioDataUri, languageCode } = input;

  if (!audioDataUri || !audioDataUri.startsWith('data:')) {
    console.error('[transcribeAudioFlow] Invalid or missing audioDataUri.');
    return { transcribedText: '[Error: Invalid audioDataUri provided to transcribeAudioFlow]' };
  }

  let tempAudioFilePath: string | null = null;

  try {
    const parts = audioDataUri.split(',');
    if (parts.length < 2) {
      console.error('[transcribeAudioFlow] Malformed audioDataUri (no base64 data part).');
      return { transcribedText: '[Error: Malformed audioDataUri (no base64 data part)]' };
    }
    const meta = parts[0]; 
    const base64Data = parts[1];
    
    const mimeTypeMatch = meta.match(/data:(audio\/[^;]+)/);
    if (!mimeTypeMatch || !mimeTypeMatch[1]) {
        console.error('[transcribeAudioFlow] Could not extract MIME type from audioDataUri meta:', meta);
        return { transcribedText: '[Error: Could not extract MIME type from audioDataUri]' };
    }
    const mimeType = mimeTypeMatch[1]; 
    
    let extension = 'audio'; 
    if (mimeType === 'audio/webm') {
        extension = 'webm';
    } else if (mimeType === 'audio/ogg' || mimeType.includes('opus')) {
        extension = 'ogg';
    } else if (mimeType === 'audio/wav' || mimeType === 'audio/wave' || mimeType === 'audio/x-wav') {
        extension = 'wav';
    } else if (mimeType === 'audio/mpeg') {
        extension = 'mp3';
    } else if (mimeType === 'audio/mp4' || mimeType === 'audio/m4a') {
        extension = 'm4a';
    }
    console.log(`[transcribeAudioFlow] Extracted MIME type from client: ${mimeType}, determined file extension for temp file: .${extension}`);

    const audioBuffer = Buffer.from(base64Data, 'base64');
    
    // -------------------------------------------------------------------------
    // VAD (Voice Activity Detection) placeholder - Not implemented in this version for this flow
    // For real-time streaming, VAD should be integrated differently, possibly server-side within RealtimeTranscriber or client-side.
    // -------------------------------------------------------------------------

    const tempDir = os.tmpdir();
    // Add random suffix to filename for more uniqueness
    tempAudioFilePath = path.join(tempDir, `lingua_vox_stt_${Date.now()}_${Math.random().toString(36).substring(2,7)}.${extension}`);
    
    await fs.writeFile(tempAudioFilePath, audioBuffer);
    console.log(`[transcribeAudioFlow] Temporary audio file saved to: ${tempAudioFilePath} (Size: ${(audioBuffer.length / 1024).toFixed(2)} KB, Type from client: ${mimeType})`);

    const pythonExecutable = process.env.PYTHON_EXECUTABLE || 'python';
    const scriptPath = path.join(process.cwd(), 'src', 'scripts', 'python', 'run_whisper.py');

    const scriptArgs: string[] = [tempAudioFilePath];
    
    const whisperModelToUse = process.env.WHISPER_MODEL || "base"; 
    scriptArgs.push(whisperModelToUse);

    if (languageCode && languageCode.trim().toLowerCase() !== 'auto') {
      scriptArgs.push(languageCode.trim());
    }

    console.log(`[transcribeAudioFlow] Executing Whisper script: ${pythonExecutable} "${scriptPath}" "${scriptArgs.join('" "')}"`);

    const { stdout, stderr } = await execFile(pythonExecutable, [scriptPath, ...scriptArgs], {
      timeout: 90000, // Increased timeout for potential FFmpeg conversion + Whisper processing
      maxBuffer: 1024 * 1024 * 10 
    });

    if (stderr) {
      // Log all stderr from Python script as it might contain FFmpeg info or Whisper warnings.
      // Filter out common, less critical warnings if necessary for cleaner logs.
      const filteredStderr = stderr.split('\n').filter(line => !line.includes("UserWarning: 1Torch was not compiled with flash attention")).join('\n');
      if (filteredStderr.trim()) {
        console.warn(`[transcribeAudioFlow] Whisper script stderr: ${filteredStderr.trim()}`);
      }
    }

    const transcribedText = stdout.trim();
    console.log(`[transcribeAudioFlow] Whisper script stdout (transcribed text): "${transcribedText.substring(0, 200)}${transcribedText.length > 200 ? "..." : ""}"`);
    
    if (!transcribedText && stderr) {
      const errorMsg = stderr.trim();
      console.error(`[transcribeAudioFlow] Transcription likely failed as stdout is empty and stderr has content.`);
      if (errorMsg.includes("FFmpeg falhou") || errorMsg.includes("Failed to load audio") || errorMsg.includes("EBML header parsing failed") || errorMsg.includes("Invalid data found when processing input")) {
        return { transcribedText: `[Whisper STT Error: FFmpeg/Whisper failed to load/process audio file. Details: ${errorMsg.split('\n').filter(line => !line.includes("UserWarning:")).pop()?.trim() || errorMsg.split('\n')[0]}]` };
      }
      return { transcribedText: `[Whisper STT Error: Script error, transcription empty. Details: ${errorMsg.split('\n').filter(line => !line.includes("UserWarning:")).pop()?.trim() || errorMsg.split('\n')[0]}]` };
    }
    
    if (!transcribedText && !stderr.trim()) {
      console.warn("[transcribeAudioFlow] Transcription resulted in empty text (stdout and stderr were empty). This might be due to silence or uninterpretable audio.");
      return { transcribedText: `[Whisper STT: Transcription resulted in empty text for ${languageCode || 'audio provided'}]` };
    }
    
    return { transcribedText };

  } catch (error: any) {
    console.error('[transcribeAudioFlow] Exception during Whisper script execution or audio processing:', error.message || error);
    let errorMessage = `[Whisper STT Exception: ${error.message || 'Unknown error'}]`;
    if (error.stderr) { 
        const stderrMsg = (error.stderr as Buffer | string).toString().trim();
        const relevantStderr = stderrMsg.split('\n').filter(line => !line.includes("UserWarning:")).join('\n').trim();
        if (relevantStderr.includes("FFmpeg falhou") || relevantStderr.includes("Failed to load audio") || relevantStderr.includes("EBML header parsing failed") || relevantStderr.includes("Invalid data found when processing input")) {
            errorMessage = `[Whisper STT Script Error: FFmpeg/Whisper failed to process audio. Details: ${relevantStderr.split('\n').pop()?.trim() || relevantStderr.split('\n')[0]}]`;
        } else if (relevantStderr.includes("Ocorreu um erro no script Python")){
            errorMessage = `[Whisper STT Script Error: Python script failed. Details: ${relevantStderr.split('\n').pop()?.trim() || relevantStderr}]`;
        }
         else if (relevantStderr) {
            errorMessage = `[Whisper STT Script Execution Error: ${relevantStderr.split('\n').pop()?.trim() || relevantStderr || error.message}]`;
        }
    } else if (error.stdout) { 
         errorMessage = `[Whisper STT Script Output Error: ${(error.stdout as Buffer | string).toString().trim().split('\n').pop()?.trim() || (error.stdout as Buffer | string).toString().trim() || error.message}]`;
    } else if (error.code) {
        errorMessage += ` (Exit Code: ${error.code})`;
    }
    
    console.error(`[transcribeAudioFlow] Error details: Code: ${error.code}, Signal: ${error.signal}, Killed: ${error.killed}`);
    
    return { transcribedText: errorMessage };
  } finally {
    if (tempAudioFilePath) {
      try {
        await fs.unlink(tempAudioFilePath);
        console.log(`[transcribeAudioFlow] Temporary audio file removed: ${tempAudioFilePath}`);
      } catch (unlinkError: any) {
        console.warn(`[transcribeAudioFlow] Failed to remove temporary audio file ${tempAudioFilePath}:`, unlinkError.message);
      }
    }
  }
}
