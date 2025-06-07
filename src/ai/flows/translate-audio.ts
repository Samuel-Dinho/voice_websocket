
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
  console.log('[translateAudio Flow Invoked] Input audioDataUri (start):', input.audioDataUri.substring(0, 100) + "...");
  return translateAudioFlow(input);
}

/*
// Comentando o ai.definePrompt para tentar uma abordagem mais stateless com ai.generate() diretamente
const prompt = ai.definePrompt({
  name: 'translateAudioPrompt',
  input: {schema: TranslateAudioInputSchema},
  output: {schema: TranslateAudioOutputSchema},
  prompt: `Translate the following audio from {{{sourceLanguage}}} to {{{targetLanguage}}}.
Audio: {{media url=audioDataUri}}
Translation:`,
});
*/

const translateAudioFlow = ai.defineFlow(
  {
    name: 'translateAudioFlow',
    inputSchema: TranslateAudioInputSchema,
    outputSchema: TranslateAudioOutputSchema,
  },
  async (input: TranslateAudioInput) => {
    console.log('[translateAudioFlow] Processing input. audioDataUri (start):', input.audioDataUri.substring(0, 200) + "...");
    
    try {
      const {output} = await ai.generate({
        prompt: [
          {text: `You are a real-time audio translator. Translate the following audio from ${input.sourceLanguage} to ${input.targetLanguage}. Provide only the translated text.`},
          {media: {url: input.audioDataUri}},
          {text: "Translation:"}
        ],
        // model: 'googleai/gemini-2.0-flash', // Removido - confiando no modelo global do genkit.ts
        output: {
          format: 'json',
          schema: TranslateAudioOutputSchema,
        },
        config: { 
            // safetySettings: [ { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE'} ]
        }
      });

      if (!output) {
          console.error('[translateAudioFlow] ai.generate did not return an output.');
          throw new Error('Translation generation failed to produce output.');
      }
      return output;

    } catch (error) {
        console.error('[translateAudioFlow] Error during ai.generate:', error);
        // Lançar o erro original para manter a stack trace e detalhes.
        // O servidor WebSocket pode adicionar seu próprio prefixo se necessário.
        throw error; 
    }
  }
);
