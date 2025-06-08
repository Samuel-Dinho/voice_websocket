
'use server';
/**
 * @fileOverview This file defines a Genkit flow for transcribing audio.
 * NOTE: THIS IS CURRENTLY A MODIFIED PLACEHOLDER FOR TESTING.
 * It returns a FIXED string to allow testing of the translation and listener pipeline.
 * For accurate and robust transcription, a dedicated STT model/service
 * (e.g., Google Cloud Speech-to-Text integrated via Genkit) will be necessary.
 *
 * - transcribeAudio - A function that initiates the audio transcription flow.
 * - TranscribeAudioInput - The input type for the transcribeAudio function.
 * - TranscribeAudioOutput - The return type for the transcribeAudio function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const TranscribeAudioInputSchema = z.object({
  audioDataUri: z
    .string()
    .describe(
      "The audio data to be transcribed, as a data URI. Expected format: 'data:<mimetype>;base64,<encoded_data>'. This is received but NOT processed by the current fixed-text logic."
    ),
  languageCode: z.string().optional().describe('The language of the audio. BCP-47 format (e.g., "en-US", "pt-BR"). Optional, not used by current fixed-text logic.'),
});

export type TranscribeAudioInput = z.infer<typeof TranscribeAudioInputSchema>;

const TranscribeAudioOutputSchema = z.object({
  transcribedText: z.string().describe('The transcribed text from the audio. Currently a fixed test string.'),
});

export type TranscribeAudioOutput = z.infer<
  typeof TranscribeAudioOutputSchema
>;

export async function transcribeAudio(
  input: TranscribeAudioInput
): Promise<TranscribeAudioOutput> {
  console.log('[transcribeAudioFlow] Fixed Text STT: Received input. Language:', input.languageCode, 'Audio URI (first 60 chars):', input.audioDataUri.substring(0, 60));
  try {
    const result = await transcribeAudioFlow(input); // Pass input for potential future use and consistency
    console.log('[transcribeAudioFlow] Fixed Text STT: Flow executed. Result:', result?.transcribedText?.substring(0,100) || "No text or error");
    return result;
  } catch (error: any) {
    console.error('[transcribeAudioFlow] Fixed Text STT: Error executing flow:', error.message || error, error.cause || error.stack);
    return { transcribedText: `[Erro na execução do fluxo de transcrição (texto fixo): ${error.message || 'Erro desconhecido'}]` };
  }
}

// This flow now directly returns a fixed string, bypassing any model call for transcription.
const transcribeAudioFlow = ai.defineFlow(
  {
    name: 'transcribeAudioFlow',
    inputSchema: TranscribeAudioInputSchema, // Still define schema for interface consistency
    outputSchema: TranscribeAudioOutputSchema,
  },
  async (input: TranscribeAudioInput) => { // Input is typed for consistency
    console.log(`[transcribeAudioFlow - flow execution] Fixed Text STT: Returning fixed text for language: ${input.languageCode || 'not specified'}`);
    const fixedTranscription = "Olá, este é um teste de transcrição de áudio da aba. O sistema está funcionando.";
    
    // Simulate a slight delay as if processing occurred
    await new Promise(resolve => setTimeout(resolve, 50)); 

    return { transcribedText: fixedTranscription };
  }
);

// Export ai and z for use in other flows if necessary
export {ai as genkitAI, z as zod};
