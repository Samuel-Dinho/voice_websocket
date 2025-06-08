
'use server';
/**
 * @fileOverview This file defines a flow for transcribing audio by
 * calling an external Python script that uses Whisper.
 * It includes placeholders for Voice Activity Detection (VAD) integration.
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
    // 1. Decode audioDataUri and extract data and MIME type
    const parts = audioDataUri.split(',');
    if (parts.length < 2) {
      console.error('[transcribeAudioFlow] Malformed audioDataUri (no base64 data part).');
      return { transcribedText: '[Error: Malformed audioDataUri (no base64 data part)]' };
    }
    const meta = parts[0]; // e.g., "data:audio/webm;codecs=opus;base64" or "data:audio/ogg;base64"
    const base64Data = parts[1];
    
    const mimeTypeMatch = meta.match(/data:(audio\/[^;]+)/);
    if (!mimeTypeMatch || !mimeTypeMatch[1]) {
        console.error('[transcribeAudioFlow] Could not extract MIME type from audioDataUri.');
        return { transcribedText: '[Error: Could not extract MIME type from audioDataUri]' };
    }
    const mimeType = mimeTypeMatch[1]; // e.g., "audio/webm" or "audio/ogg"
    
    // Determine extension based on common audio MIME types
    let extension = 'audio'; // default
    if (mimeType === 'audio/webm') {
        extension = 'webm';
    } else if (mimeType === 'audio/ogg' || mimeType.includes('opus')) { // opus is often in ogg
        extension = 'ogg';
    } else if (mimeType === 'audio/wav' || mimeType === 'audio/wave' || mimeType === 'audio/x-wav') {
        extension = 'wav';
    } else if (mimeType === 'audio/mpeg') {
        extension = 'mp3';
    } else if (mimeType === 'audio/mp4') {
        extension = 'm4a'; // or mp4, but m4a is common for audio-only mp4
    }
    console.log(`[transcribeAudioFlow] Extracted MIME type from client: ${mimeType}, determined file extension for temp file: .${extension}`);


    // Convert base64 to Buffer
    const audioBuffer = Buffer.from(base64Data, 'base64');
    
    // -------------------------------------------------------------------------
    // TODO: IMPLEMENT VOICE ACTIVITY DETECTION (VAD) HERE
    //
    // 1. Convert `audioBuffer` to Raw PCM if VAD library requires it:
    //    - The `audioBuffer` currently holds potentially compressed audio (e.g., WebM/Opus).
    //    - VAD libraries like `node-vad` typically require raw PCM audio data.
    //    - Use a library like `fluent-ffmpeg` (Node.js wrapper for FFmpeg) or an audio
    //      processing library to convert the audioBuffer (or the temp file saved below)
    //      to raw PCM (e.g., 16-bit linear PCM, 16kHz, mono).
    //      Example (conceptual using ffmpeg command line on a saved file):
    //      `ffmpeg -i input.${extension} -f s16le -ar 16000 -ac 1 output.pcm`
    //
    // 2. Initialize and Use VAD:
    //    - `const VAD = require('node-vad');` (or your chosen VAD library)
    //    - `const vad = new VAD(VAD.Mode.NORMAL);`
    //    - Feed the raw PCM audio buffer chunks to `vad.processAudio(pcmChunk)`.
    //
    // 3. Conditional Whisper Call:
    //    - `const speechDetected = vad.processAudio(allPcmDataForThisChunk);`
    //    - `if (!speechDetected) {`
    //    - `  console.log('[transcribeAudioFlow] VAD: No speech detected. Skipping Whisper.');`
    //    - `  return { transcribedText: '' }; // Return empty or a special marker`
    //    - `}`
    //    - `console.log('[transcribeAudioFlow] VAD: Speech detected. Proceeding with Whisper.');`
    // -------------------------------------------------------------------------

    // If VAD passed (or is not yet implemented), proceed to save and transcribe.
    // 2. Save audioBuffer to a temporary file
    const tempDir = os.tmpdir();
    // Create a unique filename
    tempAudioFilePath = path.join(tempDir, `lingua_vox_stt_${Date.now()}_${Math.random().toString(36).substring(2,7)}.${extension}`);
    
    await fs.writeFile(tempAudioFilePath, audioBuffer);
    console.log(`[transcribeAudioFlow] Temporary audio file saved to: ${tempAudioFilePath} (Size: ${(audioBuffer.length / 1024).toFixed(2)} KB, Type from client: ${mimeType})`);

    // 3. Prepare and call the Python script (run_whisper.py)
    const pythonExecutable = process.env.PYTHON_EXECUTABLE || 'python'; // Or 'python' / 'python3'
    
    // Ensure this path is correct relative to where the Node.js server runs.
    // process.cwd() is usually the project root.
    const scriptPath = path.join(process.cwd(), 'src', 'scripts', 'python', 'run_whisper.py');

    // Arguments for the script: <audio_file_path> [model_size] [language_code]
    const scriptArgs: string[] = [tempAudioFilePath];
    
    // You can make the Whisper model configurable, e.g., via environment variable
    const whisperModelToUse = process.env.WHISPER_MODEL || "base"; 
    scriptArgs.push(whisperModelToUse);

    if (languageCode && languageCode.trim().toLowerCase() !== 'auto') {
      scriptArgs.push(languageCode.trim());
    }
    // If languageCode is 'auto' or not provided, run_whisper.py defaults to 'auto'

    console.log(`[transcribeAudioFlow] Executing Whisper script: ${pythonExecutable} "${scriptPath}" "${scriptArgs.join('" "')}"`);

    // Execute the Python script
    const { stdout, stderr } = await execFile(pythonExecutable, [scriptPath, ...scriptArgs], {
      timeout: 60000, // 60-second timeout for transcription
      maxBuffer: 1024 * 1024 * 5 // 5MB buffer for stdout/stderr
    });

    if (stderr) {
      // Whisper might output warnings to stderr, log it but don't necessarily treat as fatal for all cases.
      // The "1Torch was not compiled with flash attention" is a UserWarning, not a critical error.
      console.warn(`[transcribeAudioFlow] Whisper script stderr: ${stderr.trim()}`);
    }

    const transcribedText = stdout.trim();
    console.log(`[transcribeAudioFlow] Whisper script stdout (transcribed text): "${transcribedText.substring(0, 200)}${transcribedText.length > 200 ? "..." : ""}"`);
    
    // Check for common FFmpeg/Whisper failure patterns in stderr if stdout is empty
    if (!transcribedText && stderr) {
      const errorMsg = stderr.trim();
      console.error(`[transcribeAudioFlow] Transcription likely failed as stdout is empty and stderr has content.`);
      if (errorMsg.includes("Failed to load audio") || errorMsg.includes("EBML header parsing failed") || errorMsg.includes("Invalid data found when processing input")) {
        return { transcribedText: `[Whisper STT Error: FFmpeg/Whisper failed to load/process audio file (${tempAudioFilePath}). Details: ${errorMsg.split('\n')[0]}]` };
      }
      return { transcribedText: `[Whisper STT Error: Script error, transcription empty. Details: ${errorMsg.split('\n')[0]}]` };
    }
    
    if (!transcribedText && !stderr) {
      // Transcription resulted in empty text, and no error was reported to stderr
      console.warn("[transcribeAudioFlow] Transcription resulted in empty text (stdout and stderr were empty). This might be due to silence or uninterpretable audio.");
      return { transcribedText: `[Whisper STT: Transcription resulted in empty text for ${languageCode || 'audio provided'}]` };
    }
    
    return { transcribedText };

  } catch (error: any) {
    // Handle errors from file operations or script execution
    console.error('[transcribeAudioFlow] Exception during Whisper script execution or audio processing:', error.message || error);
    let errorMessage = `[Whisper STT Exception: ${error.message || 'Unknown error'}]`;
    if (error.stderr) { // child_process error might have stderr with more info
        const stderrMsg = (error.stderr as Buffer | string).toString().trim();
        if (stderrMsg.includes("Failed to load audio") || stderrMsg.includes("EBML header parsing failed") || stderrMsg.includes("Invalid data found when processing input")) {
            errorMessage = `[Whisper STT Script Error: FFmpeg/Whisper failed to process audio. Details: ${stderrMsg.split('\n')[0]}]`;
        } else {
            errorMessage = `[Whisper STT Script Execution Error: ${stderrMsg.split('\n').pop()?.trim() || stderrMsg || error.message}]`;
        }
    } else if (error.stdout) { // And stdout with error message from script
         errorMessage = `[Whisper STT Script Output Error: ${(error.stdout as Buffer | string).toString().trim().split('\n').pop()?.trim() || (error.stdout as Buffer | string).toString().trim() || error.message}]`;
    } else if (error.code) { // e.g. if python script exits with non-zero code
        errorMessage += ` (Exit Code: ${error.code})`;
    }
    
    console.error(`[transcribeAudioFlow] Error details: Code: ${error.code}, Signal: ${error.signal}, Killed: ${error.killed}`);
    
    return { transcribedText: errorMessage };
  } finally {
    // 4. Clean up the temporary audio file
    if (tempAudioFilePath) {
      try {
        await fs.unlink(tempAudioFilePath);
        console.log(`[transcribeAudioFlow] Temporary audio file removed: ${tempAudioFilePath}`);
      } catch (unlinkError: any) {
        // Log an error if the temporary file cannot be removed, but don't fail the whole process
        console.warn(`[transcribeAudioFlow] Failed to remove temporary audio file ${tempAudioFilePath}:`, unlinkError.message);
      }
    }
  }
}

// Nota: A integração VAD, conforme descrito nos comentários TODO, é uma otimização importante
// a ser considerada para evitar o processamento desnecessário de silêncio.
// A lógica atual chama o script Whisper para cada chunk de áudio recebido que passa
// as verificações iniciais do audioDataUri.
