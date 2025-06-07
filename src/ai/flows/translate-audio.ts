
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
  sourceLanguage: z.string().describe('The language of the audio to be transcribed and then translated.'),
  targetLanguage: z.string().describe('The language to translate the transcribed text to.'),
});
export type TranslateAudioInput = z.infer<typeof TranslateAudioInputSchema>;

const TranslateAudioOutputSchema = z.object({
  translatedText: z.string().describe('The translated text of the audio.'),
});
export type TranslateAudioOutput = z.infer<typeof TranslateAudioOutputSchema>;

// Schema for the intermediate transcription step (still useful if we re-introduce JSON later)
const TranscriptionOutputSchema = z.object({
  transcribedText: z.string().describe('The transcribed text from the audio.'),
});
type TranscriptionOutput = z.infer<typeof TranscriptionOutputSchema>;


export async function translateAudio(input: TranslateAudioInput): Promise<TranslateAudioOutput> {
  console.log('[translateAudio Flow Invoked] Input audioDataUri (start):', input.audioDataUri.substring(0, 100) + "...");
  return translateAudioFlow(input);
}

const translateAudioFlow = ai.defineFlow(
  {
    name: 'translateAudioFlow',
    inputSchema: TranslateAudioInputSchema,
    outputSchema: TranslateAudioOutputSchema,
  },
  async (input: TranslateAudioInput) => {
    console.log('[translateAudioFlow] Processing input. audioDataUri (start):', input.audioDataUri.substring(0, 200) + "...");
    
    try {
      // Step 1: Transcribe audio to text
      console.log(`[translateAudioFlow] Step 1: Transcribing audio from ${input.sourceLanguage}. audioDataUri (start): ${input.audioDataUri.substring(0,60)}...`);
      const transcriptionResponse = await ai.generate({
        prompt: [
          {text: `You are an audio transcription expert. Transcribe the following audio from ${input.sourceLanguage}. Provide only the transcribed text.`},
          {media: {url: input.audioDataUri}},
          {text: "Transcription:"}
        ],
        // No longer requesting JSON output for transcription, will use response.text
        config: { 
          safetySettings: [
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          ]
        }
      });

      const transcribedText = transcriptionResponse.text?.trim(); // Get raw text, trim whitespace
      console.log(`[translateAudioFlow] Raw transcription text: "${transcribedText}"`);

      if (!transcribedText) { // Check if transcribedText is null, undefined, or empty string
          console.warn('[translateAudioFlow] Transcription step returned no text or empty text. Skipping translation.');
          return { translatedText: "" }; // Return empty if transcription is empty or failed to produce text
      }

      // Step 2: Translate transcribed text
      console.log(`[translateAudioFlow] Step 2: Translating text "${transcribedText}" from ${input.sourceLanguage} to ${input.targetLanguage}.`);
      const translationResponse = await ai.generate({
        prompt: `You are a text translation expert. Translate the following text from ${input.sourceLanguage} to ${input.targetLanguage}. Provide only the translated text. Text to translate: "${transcribedText}"`,
        output: {
          format: 'json',
          schema: TranslateAudioOutputSchema,
        },
        config: { 
          safetySettings: [
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          ]
        }
      });

      if (!translationResponse.output) {
          console.error('[translateAudioFlow] Translation step did not return an output.');
          throw new Error('Translation generation failed to produce output.');
      }
      console.log(`[translateAudioFlow] Translated text: "${translationResponse.output.translatedText}"`);
      return translationResponse.output;

    } catch (error) {
        console.error('[translateAudioFlow] Error during ai.generate (transcription or translation):', error);
        throw error; 
    }
  }
);
