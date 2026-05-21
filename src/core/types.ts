export type FrameSelectionMode = "top-k" | "density";
export type OutputMode = "watch" | "style" | "prompt" | "shot-specs" | "all";
export type ExtractionKind = "text" | "full";

export type AnalyzeVideoOptions = {
  url: string;
  outputDir?: string;
  topK?: number;
  mode?: FrameSelectionMode;
  selectionMode?: FrameSelectionMode;
  outputMode?: OutputMode;
  extractionKind?: ExtractionKind;
  candidateIntervalSeconds?: number;
  maxCandidateFrames?: number;
  frameWidth?: number;
  keepWorkDir?: boolean;
  openAiApiKey?: string;
  transcribeModel?: string;
  visionModel?: string;
  embeddingModel?: string;
  onProgress?: (event: ProgressEvent) => void;
};

export type ProgressStage =
  | "info"
  | "download"
  | "audio"
  | "transcribe"
  | "frames"
  | "vision"
  | "embed"
  | "select"
  | "cinematic"
  | "artifacts"
  | "done";

export type ProgressEvent = {
  stage: ProgressStage;
  label: string;
  detail?: string;
  current?: number;
  total?: number;
  pct: number;
  elapsedMs: number;
};

export type VideoMetadata = {
  id?: string;
  title?: string;
  uploader?: string;
  durationSeconds: number;
  webpageUrl: string;
  thumbnail?: string;
};

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type CandidateFrame = {
  index: number;
  timestamp: number;
  path: string;
  fileName: string;
  visualVector: number[];
  visualNovelty: number;
  brightness: number;
  colorfulness: number;
};

export type FrameAnalysis = CandidateFrame & {
  description: string;
  labels: string[];
  visualSalience: number;
  semanticNovelty: number;
  transcriptDensity: number;
  score: number;
  transcriptContext: string;
  dataUrl?: string;
};

export type StyleShotPattern = {
  name: string;
  function: string;
  visualGrammar: string;
  evidenceFrameIndexes: number[];
  reuseNotes: string;
};

export type StyleBible = {
  title: string;
  oneSentenceThesis: string;
  referenceLineage: string[];
  productionOntology: string;
  cinematicPrinciples: string[];
  visualLanguage: {
    camera: string;
    lensing: string;
    lighting: string;
    composition: string;
    colorPalette: string;
    materiality: string;
    motion: string;
    editing: string;
    typography: string;
    sound: string;
    performance: string;
  };
  narrationLanguage: {
    register: string;
    syntaxRules: string[];
    openingPatterns: string[];
    forbiddenPhrases: string[];
    sampleLines: string[];
  };
  shotPatterns: StyleShotPattern[];
  transferRules: string[];
};

export type ShotSpec = {
  id: string;
  sourceFrameIndex: number;
  sourceTimestamp: number;
  sourceFrameFile: string;
  shotType: string;
  purpose: string;
  narrationRole: string;
  subject: string;
  environment: string;
  camera: {
    lens: string;
    focalLengthMm: number | null;
    aperture: string;
    rig: string;
    movement: string;
    durationSeconds: number;
    focusBehavior: string;
  };
  lighting: {
    setup: string;
    key: string;
    fill: string;
    rim: string;
    practicals: string;
  };
  materials: string[];
  composition: string;
  remotionRole: string;
  diffusionIntent: string;
  renderPasses: string[];
  forbiddenMoves: string[];
  prompt: string;
};

export type SlopWarning = {
  rule: string;
  whyItBreaksTaste: string;
  rejectIf: string;
  preferredMove: string;
};

export type CinematicAnalysis = {
  styleBible: StyleBible;
  shotSpecs: ShotSpec[];
  codexPrompt: string;
  slopWarnings: SlopWarning[];
  styleMarkdown: string;
  shotSpecMarkdown: string;
  promptMarkdown: string;
};

export type VideoAnalysisResult = {
  id: string;
  createdAt: string;
  sourceUrl: string;
  extractionKind: ExtractionKind;
  metadata: VideoMetadata;
  options: Required<
    Pick<
      AnalyzeVideoOptions,
      | "topK"
      | "mode"
      | "outputMode"
      | "candidateIntervalSeconds"
      | "maxCandidateFrames"
      | "frameWidth"
      | "transcribeModel"
      | "visionModel"
      | "embeddingModel"
    >
  >;
  transcriptText: string;
  transcriptSegments: TranscriptSegment[];
  frames: FrameAnalysis[];
  cinematic: CinematicAnalysis;
  artifacts: {
    outputDir: string;
    markdownPath: string;
    stylePath: string;
    shotSpecsPath: string;
    shotSpecsMarkdownPath: string;
    codexPromptPath: string;
    metadataPath: string;
    zipPath: string;
    frameDir: string;
  };
  markdown: string;
};
