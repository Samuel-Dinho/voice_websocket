'use server';
/**
 * @fileOverview This file defines a Genkit flow for transcribing audio.
 * NOTE: The current Genkit model (gemini-2.0-flash) is not primarily a Speech-to-Text model.
 * This flow is a structural placeholder; actual STT may require a different model/plugin.
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
      "The audio data to be transcribed, as a data URI. Expected format: 'data:<mimetype>;base64,<encoded_data>'."
    ),
  languageCode: z.string().optional().describe('The language of the audio. BCP-47 format (e.g., "en-US", "pt-BR"). Optional, model may auto-detect.'),
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
  return transcribeAudioFlow(input);
}

const transcribeAudioPrompt = ai.definePrompt({
  name: 'transcribeAudioPrompt',
  input: {
    schema: TranscribeAudioInputSchema,
  },
  output: {
    schema: TranscribeAudioOutputSchema,
  },
  prompt: `You are a Speech-to-Text engine. Your task is to transcribe the provided audio accurately.
If a language code is provided ({{{languageCode}}}), use it. Otherwise, attempt to auto-detect the language.
Audio to transcribe: {{media url=audioDataUri}}

Return ONLY the transcribed text.`,
});

const transcribeAudioFlow = ai.defineFlow(
  {
    name: 'transcribeAudioFlow',
    inputSchema: TranscribeAudioInputSchema,
    outputSchema: TranscribeAudioOutputSchema,
  },
  async input => {
    // Note: Gemini Flash is not primarily an STT model.
    // For real STT, a dedicated STT model/plugin in Genkit would be needed.
    // This is a placeholder for the STT step.
    const {output} = await transcribeAudioPrompt(input);
    if (!output || !output.transcribedText) {
        // Fallback or error handling if transcription is empty/failed
        console.warn('[transcribeAudioFlow] Transcription output was empty or invalid from the model.');
        return { transcribedText: "[Transcription placeholder - STT model needed]" };
    }
    return output;
  }
);
