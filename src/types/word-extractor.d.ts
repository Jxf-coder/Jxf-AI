declare module "word-extractor" {
  export interface WordExtractorDocument {
    getBody(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getHeaders(): string;
    getFooters(): string;
    getAnnotations(): string;
    getTextboxes(): string;
  }

  export default class WordExtractor {
    extract(source: Buffer | string): Promise<WordExtractorDocument>;
  }
}
