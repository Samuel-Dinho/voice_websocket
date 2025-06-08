
'use server';
/**
 * @fileOverview This file defines a Genkit flow for transcribing audio.
 * NOTE: The current Genkit model (gemini-2.0-flash) is NOT a dedicated Speech-to-Text (STT) model.
 * This flow serves as a structural placeholder. For accurate and robust transcription,
 * especially for production use, this flow MUST be updated to use a dedicated STT model/service
 * (e.g., Google Cloud Speech-to-Text integrated via Genkit).
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
    // IMPORTANT: gemini-2.0-flash (or similar general LLMs) are not designed for robust Speech-to-Text.
    // For accurate transcription, this should use a dedicated STT model/plugin within Genkit.
    // The current implementation is a placeholder and will likely produce inaccurate results.
    console.log('[transcribeAudioFlow] Attempting transcription with general LLM (placeholder for dedicated STT). Input language: ', input.languageCode);
    const {output} = await transcribeAudioPrompt(input);

    if (!output || !output.transcribedText || output.transcribedText.trim() === "") {
        console.warn('[transcribeAudioFlow] Transcription output was empty or invalid from the model. This is expected if a non-STT model is used.');
        return { transcribedText: "[Transcrição imprecisa - Modelo STT dedicado necessário no servidor]" };
    }
    console.log('[transcribeAudioFlow] Placeholder transcription generated: "', output.transcribedText.substring(0, 50),'..."');
    return output;
  }
);

// Export ai and z for use in other flows if necessary
export {ai as genkitAI, z as zod};
