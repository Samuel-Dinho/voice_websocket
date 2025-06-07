
'use server';

/**
 * @fileOverview Real-time audio translation flow.
 *
 * - translateAudio - A function that handles the audio translation process.
 * - TranslateAudioInput - The input type for the translateAudio function.
 * - TranslateAudioOutput - The return type for the translateAudio function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const TranslateAudioInputSchema = z.object({
  audioDataUri: z
    .string()
    .describe(
      "The audio data as a data URI that must include a MIME type and use Base64 encoding. Expected format: 'data:<mimetype>;base64,<encoded_data>'."
    ),
  sourceLanguage: z.string().describe('The language of the audio to be translated.'),
  targetLanguage: z.string().describe('The language to translate the audio to.'),
});
export type TranslateAudioInput = z.infer<typeof TranslateAudioInputSchema>;

const TranslateAudioOutputSchema = z.object({
  translatedText: z.string().describe('The translated text of the audio.'),
});
export type TranslateAudioOutput = z.infer<typeof TranslateAudioOutputSchema>;

export async function translateAudio(input: TranslateAudioInput): Promise<TranslateAudioOutput> {
  // console.log('[translateAudio Flow] Received input. audioDataUri (start):', input.audioDataUri.substring(0, 100) + "...");
  return translateAudioFlow(input);
}

const prompt = ai.definePrompt({
  name: 'translateAudioPrompt',
  input: {schema: TranslateAudioInputSchema},
  output: {schema: TranslateAudioOutputSchema},
  prompt: `Translate the following audio from {{{sourceLanguage}}} to {{{targetLanguage}}}.
Audio: {{media url=audioDataUri}}
Translation:`,
});

const translateAudioFlow = ai.defineFlow(
  {
    name: 'translateAudioFlow',
    inputSchema: TranslateAudioInputSchema,
    outputSchema: TranslateAudioOutputSchema,
  },
  async (input: TranslateAudioInput) => {
    console.log('[translateAudioFlow] Processing input. audioDataUri (start):', input.audioDataUri.substring(0, 200) + "...");
    const {output} = await prompt(input);
    if (!output) {
        console.error('[translateAudioFlow] Prompt did not return an output.');
        throw new Error('Translation prompt failed to produce output.');
    }
    return output;
  }
);
