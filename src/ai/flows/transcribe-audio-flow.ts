
'use server';
/**
 * @fileOverview This file defines a Genkit flow for transcribing audio
 * by calling an external Python script that uses Whisper.
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

const execFile = util.promisify(execFileCallback);


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
  console.log(`[transcribeAudioFlow] Iniciando transcrição com Whisper via script Python. Idioma: ${input.languageCode || 'auto'}.`);

  const { audioDataUri, languageCode } = input;

  if (!audioDataUri || !audioDataUri.startsWith('data:')) {
    console.error('[transcribeAudioFlow] audioDataUri inválido ou ausente.');
    return { transcribedText: '[Error: Invalid audioDataUri provided to transcribeAudioFlow]' };
  }

  let tempAudioFilePath: string | null = null;

  try {
    // 1. Decodificar audioDataUri e extrair dados e MIME type
    const parts = audioDataUri.split(',');
    if (parts.length < 2) {
      console.error('[transcribeAudioFlow] audioDataUri mal formado (sem parte de dados base64).');
      return { transcribedText: '[Error: Malformed audioDataUri (no base64 data part)]' };
    }
    const meta = parts[0]; // e.g., "data:audio/webm;codecs=opus;base64" or "data:audio/ogg;base64"
    const base64Data = parts[1];
    
    const mimeTypeMatch = meta.match(/data:(audio\/[^;]+)/);
    if (!mimeTypeMatch || !mimeTypeMatch[1]) {
        console.error('[transcribeAudioFlow] Não foi possível extrair o MIME type do audioDataUri.');
        return { transcribedText: '[Error: Could not extract MIME type from audioDataUri]' };
    }
    const mimeType = mimeTypeMatch[1]; // e.g., "audio/webm" or "audio/ogg"
    const extension = mimeType.split('/')[1] || 'audio'; // e.g., "webm" or "ogg"


    // 2. Converter base64 para Buffer e salvar em arquivo temporário
    const audioBuffer = Buffer.from(base64Data, 'base64');
    const tempDir = os.tmpdir();
    tempAudioFilePath = path.join(tempDir, `lingua_vox_stt_${Date.now()}_${Math.random().toString(36).substring(2,7)}.${extension}`);
    
    await fs.writeFile(tempAudioFilePath, audioBuffer);
    console.log(`[transcribeAudioFlow] Áudio temporário salvo em: ${tempAudioFilePath} (Tamanho: ${(audioBuffer.length / 1024).toFixed(2)} KB)`);

    // 3. Preparar e chamar o script Python run_whisper.py
    const pythonExecutable = process.env.PYTHON_EXECUTABLE || 'python3'; // Ou 'python', dependendo do ambiente
    
    // Caminho para o script Python. Garanta que este caminho está correto.
    // process.cwd() é geralmente a raiz do projeto em desenvolvimento.
    const scriptPath = path.join(process.cwd(), 'src', 'scripts', 'python', 'run_whisper.py');

    // Argumentos para o script: <caminho_do_audio> [modelo] [idioma]
    // Script: sys.argv[1]=audio_file, sys.argv[2]=model_size(opt,def:'base'), sys.argv[3]=language(opt,def:'auto')
    const scriptArgs: string[] = [tempAudioFilePath];
    const whisperModelToUse = process.env.WHISPER_MODEL || "base"; // Pode ser configurável via .env

    scriptArgs.push(whisperModelToUse); // Modelo é o segundo argumento

    if (languageCode && languageCode.trim().toLowerCase() !== 'auto') {
      scriptArgs.push(languageCode.trim()); // Idioma é o terceiro argumento, se fornecido e não 'auto'
    }
    // Se languageCode for 'auto' ou não fornecido, o script Python usará 'auto' como padrão para o idioma.

    console.log(`[transcribeAudioFlow] Executando: ${pythonExecutable} ${scriptPath} ${scriptArgs.join(' ')}`);

    const { stdout, stderr } = await execFile(pythonExecutable, [scriptPath, ...scriptArgs], {
      timeout: 60000, // Timeout de 60 segundos para a transcrição
      maxBuffer: 1024 * 1024 * 5 // Buffer de 5MB para stdout/stderr
    });

    if (stderr) {
      // Logar stderr, mas não tratar como erro fatal imediatamente, pois Whisper pode enviar avisos para stderr.
      console.warn(`[transcribeAudioFlow] Saída de erro (stderr) do script Whisper: ${stderr.trim()}`);
    }

    const transcribedText = stdout.trim();
    console.log(`[transcribeAudioFlow] Texto transcrito (stdout): "${transcribedText.substring(0, 200)}${transcribedText.length > 200 ? "..." : ""}"`);

    if (!transcribedText && stderr) {
      // Se stdout está vazio e houve stderr, é mais provável que seja um erro real.
      console.error(`[transcribeAudioFlow] Transcrição falhou. Stderr: ${stderr.trim()}`);
      return { transcribedText: `[Whisper STT Error: ${stderr.trim().split('\n').pop() || 'Unknown error from script'}]` };
    }
    
    if (!transcribedText && !stderr) {
      console.warn("[transcribeAudioFlow] Transcrição resultou em texto vazio (stdout e stderr vazios).");
      return { transcribedText: `[Whisper STT: Transcription resulted in empty text for ${languageCode || 'audio provided'}]` };
    }
    
    return { transcribedText };

  } catch (error: any) {
    console.error('[transcribeAudioFlow] Exceção durante a execução do script Whisper ou processamento de áudio:', error.message || error);
    let errorMessage = `[Whisper STT Exception: ${error.message || 'Unknown error'}]`;
    if (error.stderr) { // Erro de child_process pode ter stderr
        errorMessage = `[Whisper STT Script Execution Error: ${error.stderr.trim().split('\n').pop() || error.stderr.trim() || error.message}]`;
    } else if (error.stdout) { // E stdout com mensagem de erro do script
         errorMessage = `[Whisper STT Script Output Error: ${error.stdout.trim().split('\n').pop() || error.stdout.trim() || error.message}]`;
    } else if (error.code) {
        errorMessage += ` (Code: ${error.code})`;
    }
    
    console.error(`[transcribeAudioFlow] Detalhes do erro: Code: ${error.code}, Signal: ${error.signal}, Killed: ${error.killed}`);
    
    return { transcribedText: errorMessage };
  } finally {
    // 4. Limpar arquivo de áudio temporário
    if (tempAudioFilePath) {
      try {
        await fs.unlink(tempAudioFilePath);
        console.log(`[transcribeAudioFlow] Arquivo de áudio temporário removido: ${tempAudioFilePath}`);
      } catch (unlinkError: any) {
        console.warn(`[transcribeAudioFlow] Falha ao remover arquivo de áudio temporário ${tempAudioFilePath}:`, unlinkError.message);
      }
    }
  }
}
