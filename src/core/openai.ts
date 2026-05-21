import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import OpenAI from "openai";

import { cosineSimilarity, normalize } from "./math";
import { formatTimestamp } from "./time";
import type {
  CandidateFrame,
  CinematicAnalysis,
  FrameAnalysis,
  ShotSpec,
  SlopWarning,
  StyleBible,
  TranscriptSegment
} from "./types";

type VisionJson = {
  description?: string;
  labels?: string[];
  salience?: number;
};

function parseJsonObject<T>(text: string, fallback: T): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return fallback;
    }
  }
}

export function createOpenAiClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

export async function transcribeAudioChunks(params: {
  client: OpenAI;
  chunks: string[];
  chunkSeconds: number;
  model: string;
}): Promise<{ text: string; segments: TranscriptSegment[] }> {
  const segments: TranscriptSegment[] = [];

  for (let index = 0; index < params.chunks.length; index += 1) {
    const chunkPath = params.chunks[index];
    const offset = index * params.chunkSeconds;
    const response = (await params.client.audio.transcriptions.create({
      file: createReadStream(chunkPath),
      model: params.model,
      response_format: "verbose_json",
      timestamp_granularities: ["segment"]
    } as never)) as {
      text?: string;
      segments?: Array<{ start: number; end: number; text: string }>;
    };

    if (response.segments?.length) {
      for (const segment of response.segments) {
        segments.push({
          start: offset + segment.start,
          end: offset + segment.end,
          text: segment.text.trim()
        });
      }
    } else if (response.text) {
      segments.push({
        start: offset,
        end: offset + params.chunkSeconds,
        text: response.text.trim()
      });
    }
  }

  return {
    text: segments.map((segment) => segment.text).join(" ").trim(),
    segments
  };
}

async function describeFrame(params: {
  client: OpenAI;
  model: string;
  frame: CandidateFrame;
  transcriptContext: string;
}): Promise<{ description: string; labels: string[]; visualSalience: number }> {
  const imageBuffer = await readFile(params.frame.path);
  const imageUrl = `data:image/jpeg;base64,${imageBuffer.toString("base64")}`;

  const response = await params.client.responses.create({
    model: params.model,
    text: { format: { type: "json_object" } },
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Analyze this video frame for a VLM that cannot watch the video. " +
              "Return strict JSON with keys description, labels, salience. " +
              "description should be one concise sentence that names visible subjects, setting, screen text, actions, and composition. " +
              "labels should be 3-8 short semantic tags. salience is a number 0-1 for how representative or information-rich this frame is. " +
              `Nearby transcript context: ${params.transcriptContext || "(none)"}`
          },
          {
            type: "input_image",
            image_url: imageUrl,
            detail: "low"
          }
        ]
      }
    ]
  });

  const parsed = parseJsonObject<VisionJson>(response.output_text || "", {
    description: response.output_text || "",
    labels: [],
    salience: 0.5
  });
  return {
    description: parsed.description || response.output_text || "No description returned.",
    labels: Array.isArray(parsed.labels) ? parsed.labels.map(String).slice(0, 8) : [],
    visualSalience:
      typeof parsed.salience === "number" && Number.isFinite(parsed.salience)
        ? Math.min(1, Math.max(0, parsed.salience))
        : 0.5
  };
}

function transcriptContextAt(segments: TranscriptSegment[], timestamp: number, radiusSeconds: number): string {
  return segments
    .filter((segment) => segment.end >= timestamp - radiusSeconds && segment.start <= timestamp + radiusSeconds)
    .map((segment) => segment.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
}

function transcriptDensityAt(segments: TranscriptSegment[], timestamp: number, radiusSeconds: number): number {
  const context = transcriptContextAt(segments, timestamp, radiusSeconds);
  return Math.min(1, context.length / 900);
}

export async function analyzeFramesSemantically(params: {
  client: OpenAI;
  candidates: CandidateFrame[];
  transcriptSegments: TranscriptSegment[];
  visionModel: string;
  embeddingModel: string;
}): Promise<FrameAnalysis[]> {
  const described: Array<FrameAnalysis & { embedding?: number[] }> = [];

  for (const candidate of params.candidates) {
    const transcriptContext = transcriptContextAt(params.transcriptSegments, candidate.timestamp, 12);
    const vision = await describeFrame({
      client: params.client,
      model: params.visionModel,
      frame: candidate,
      transcriptContext
    });
    described.push({
      ...candidate,
      ...vision,
      semanticNovelty: 0,
      transcriptDensity: transcriptDensityAt(params.transcriptSegments, candidate.timestamp, 12),
      score: 0,
      transcriptContext
    });
  }

  if (described.length > 0) {
    const embeddingResponse = await params.client.embeddings.create({
      model: params.embeddingModel,
      input: described.map((frame) => `${frame.description}\nTags: ${frame.labels.join(", ")}`),
      encoding_format: "float"
    });

    embeddingResponse.data.forEach((item, index) => {
      described[index].embedding = item.embedding;
    });
  }

  const semanticNovelty = described.map((frame, index) => {
    const current = frame.embedding;
    if (!current) return 0.5;
    const prev = described[index - 1]?.embedding;
    const next = described[index + 1]?.embedding;
    const diffs = [prev, next]
      .filter((embedding): embedding is number[] => Boolean(embedding))
      .map((embedding) => 1 - cosineSimilarity(current, embedding));
    return diffs.length ? diffs.reduce((sum, value) => sum + value, 0) / diffs.length : 0.5;
  });

  const normalizedSemanticNovelty = normalize(semanticNovelty);
  const normalizedVisualNovelty = normalize(described.map((frame) => frame.visualNovelty));

  return described.map((frame, index) => {
    const score =
      0.38 * frame.visualSalience +
      0.26 * normalizedSemanticNovelty[index] +
      0.2 * normalizedVisualNovelty[index] +
      0.1 * frame.transcriptDensity +
      0.06 * frame.colorfulness;

    const { embedding: _embedding, ...withoutEmbedding } = frame;
    return {
      ...withoutEmbedding,
      semanticNovelty: normalizedSemanticNovelty[index],
      visualNovelty: normalizedVisualNovelty[index],
      score: Number(score.toFixed(4))
    };
  });
}

type RawCinematicAnalysis = Partial<{
  styleBible: Partial<StyleBible>;
  shotSpecs: Partial<ShotSpec>[];
  codexPrompt: string;
  slopWarnings: Partial<SlopWarning>[];
}>;

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function asNumber(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function defaultStyleBible(title: string): StyleBible {
  return {
    title,
    oneSentenceThesis:
      "This reference establishes a physically grounded product-film grammar from its selected frames, transcript, pacing, and narration register.",
    referenceLineage: ["reference video analysis", "cinematic grammar extraction", "coding-agent prompt compiler"],
    productionOntology:
      "Treat every frame as evidence of a real camera observing persistent objects in coherent space.",
    cinematicPrinciples: [
      "Start with concrete visual evidence rather than generic announcements.",
      "Preserve camera, lighting, material, and environmental causality.",
      "Make every generated shot physically plausible before adding style or typography."
    ],
    visualLanguage: {
      camera: "Physically motivated camera movement only.",
      lensing: "Lens choices should imply real optics, depth, and focal behavior.",
      lighting: "Lighting should reveal material structure rather than decorate a slide.",
      composition: "Compose around object presence and spatial hierarchy.",
      colorPalette: "Use controlled palettes grounded in the source environment.",
      materiality: "Prioritize surfaces, edges, contact shadows, and manufacturing evidence.",
      motion: "Move through rigs, focus pulls, and motivated performer action.",
      editing: "Cut for spatial and rhetorical continuity.",
      typography: "Keep typography sparse, secondary, and physically or editorially justified.",
      sound: "Use sound as atmosphere and authority, not dopamine pacing.",
      performance: "Human presence should feel observed, not presenter-template staged."
    },
    narrationLanguage: {
      register: "Sparse, declarative, materially grounded industrial prose.",
      syntaxRules: [
        "Prefer short noun-forward assertions.",
        "Pair every abstraction with a visible physical referent.",
        "Avoid conversational filler and founder excitement."
      ],
      openingPatterns: [
        "A singular new form.",
        "A re-engineered system.",
        "Built around material, light, and motion."
      ],
      forbiddenPhrases: [
        "we're excited to announce",
        "built for teams",
        "reimagine productivity",
        "supercharge your workflow"
      ],
      sampleLines: [
        "A new layer of perception.",
        "Machined for continuous presence.",
        "Designed to remain quiet until the moment it matters."
      ]
    },
    shotPatterns: [],
    transferRules: []
  };
}

function canonicalizeCinematicAnalysis(params: {
  raw: RawCinematicAnalysis;
  title: string;
  frames: FrameAnalysis[];
}): Omit<CinematicAnalysis, "styleMarkdown" | "shotSpecMarkdown" | "promptMarkdown"> {
  const fallbackBible = defaultStyleBible(params.title);
  const rawBible = params.raw.styleBible || {};
  const visualLanguage = (rawBible.visualLanguage || {}) as Partial<StyleBible["visualLanguage"]>;
  const narrationLanguage = (rawBible.narrationLanguage || {}) as Partial<StyleBible["narrationLanguage"]>;

  const styleBible: StyleBible = {
    ...fallbackBible,
    ...rawBible,
    title: String(rawBible.title || fallbackBible.title),
    oneSentenceThesis: String(rawBible.oneSentenceThesis || fallbackBible.oneSentenceThesis),
    referenceLineage: asStringArray(rawBible.referenceLineage).length
      ? asStringArray(rawBible.referenceLineage)
      : fallbackBible.referenceLineage,
    productionOntology: String(rawBible.productionOntology || fallbackBible.productionOntology),
    cinematicPrinciples: asStringArray(rawBible.cinematicPrinciples).length
      ? asStringArray(rawBible.cinematicPrinciples)
      : fallbackBible.cinematicPrinciples,
    visualLanguage: {
      camera: String(visualLanguage.camera || fallbackBible.visualLanguage.camera),
      lensing: String(visualLanguage.lensing || fallbackBible.visualLanguage.lensing),
      lighting: String(visualLanguage.lighting || fallbackBible.visualLanguage.lighting),
      composition: String(visualLanguage.composition || fallbackBible.visualLanguage.composition),
      colorPalette: String(visualLanguage.colorPalette || fallbackBible.visualLanguage.colorPalette),
      materiality: String(visualLanguage.materiality || fallbackBible.visualLanguage.materiality),
      motion: String(visualLanguage.motion || fallbackBible.visualLanguage.motion),
      editing: String(visualLanguage.editing || fallbackBible.visualLanguage.editing),
      typography: String(visualLanguage.typography || fallbackBible.visualLanguage.typography),
      sound: String(visualLanguage.sound || fallbackBible.visualLanguage.sound),
      performance: String(visualLanguage.performance || fallbackBible.visualLanguage.performance)
    },
    narrationLanguage: {
      register: String(narrationLanguage.register || fallbackBible.narrationLanguage.register),
      syntaxRules: asStringArray(narrationLanguage.syntaxRules).length
        ? asStringArray(narrationLanguage.syntaxRules)
        : fallbackBible.narrationLanguage.syntaxRules,
      openingPatterns: asStringArray(narrationLanguage.openingPatterns).length
        ? asStringArray(narrationLanguage.openingPatterns)
        : fallbackBible.narrationLanguage.openingPatterns,
      forbiddenPhrases: asStringArray(narrationLanguage.forbiddenPhrases).length
        ? asStringArray(narrationLanguage.forbiddenPhrases)
        : fallbackBible.narrationLanguage.forbiddenPhrases,
      sampleLines: asStringArray(narrationLanguage.sampleLines).length
        ? asStringArray(narrationLanguage.sampleLines)
        : fallbackBible.narrationLanguage.sampleLines
    },
    shotPatterns: Array.isArray(rawBible.shotPatterns)
      ? rawBible.shotPatterns.map((pattern, index) => ({
          name: String(pattern.name || `Pattern ${index + 1}`),
          function: String(pattern.function || "Reusable cinematic function."),
          visualGrammar: String(pattern.visualGrammar || "Physically grounded shot grammar."),
          evidenceFrameIndexes: Array.isArray(pattern.evidenceFrameIndexes)
            ? pattern.evidenceFrameIndexes.map(Number).filter(Number.isFinite)
            : [],
          reuseNotes: String(pattern.reuseNotes || "Reuse with the same camera, material, and pacing logic.")
        }))
      : fallbackBible.shotPatterns,
    transferRules: asStringArray(rawBible.transferRules).length
      ? asStringArray(rawBible.transferRules)
      : [
          "Convert each reference frame into a shot with explicit lens, rig, lighting, material, and edit intent.",
          "Treat Remotion as editorial assembly unless a shot is intentionally interface-native.",
          "Reject outputs whose motion cannot be explained by a camera rig, performer action, physical display, or motivated edit."
        ]
  };

  const shotSpecs: ShotSpec[] = (Array.isArray(params.raw.shotSpecs) ? params.raw.shotSpecs : []).map(
    (shot, index) => {
      const sourceFrame = params.frames.find((frame) => frame.index === Number(shot.sourceFrameIndex)) || params.frames[index] || params.frames[0];
      return {
        id: String(shot.id || `shot-${(index + 1).toString().padStart(2, "0")}`),
        sourceFrameIndex: Number(sourceFrame?.index ?? index),
        sourceTimestamp: Number(sourceFrame?.timestamp ?? 0),
        sourceFrameFile: String(sourceFrame?.fileName || shot.sourceFrameFile || ""),
        shotType: String(shot.shotType || "cinematic_reference_shot"),
        purpose: String(shot.purpose || "Translate reference-frame grammar into a reusable production shot."),
        narrationRole: String(shot.narrationRole || "Support a sparse declarative narration line."),
        subject: String(shot.subject || sourceFrame?.description || "Reference subject"),
        environment: String(shot.environment || "Coherent physical environment inferred from the reference."),
        camera: {
          lens: String(shot.camera?.lens || "physically plausible cinema lens"),
          focalLengthMm: asNumber(shot.camera?.focalLengthMm, null),
          aperture: String(shot.camera?.aperture || "shallow depth of field where appropriate"),
          rig: String(shot.camera?.rig || "locked-off tripod or slow slider"),
          movement: String(shot.camera?.movement || "restrained motivated movement"),
          durationSeconds: Number(asNumber(shot.camera?.durationSeconds, 5) || 5),
          focusBehavior: String(shot.camera?.focusBehavior || "stable focus with motivated pulls only")
        },
        lighting: {
          setup: String(shot.lighting?.setup || "coherent source-motivated lighting"),
          key: String(shot.lighting?.key || "soft controlled key"),
          fill: String(shot.lighting?.fill || "minimal fill"),
          rim: String(shot.lighting?.rim || "subtle edge separation"),
          practicals: String(shot.lighting?.practicals || "only if present in the environment")
        },
        materials: asStringArray(shot.materials).length ? asStringArray(shot.materials) : ["physically based materials"],
        composition: String(shot.composition || "Composition must survive as a still frame."),
        remotionRole: String(shot.remotionRole || "Editorial assembly only; no slide-like visual substrate."),
        diffusionIntent: String(shot.diffusionIntent || "Photographic finishing while preserving Blender geometry and camera causality."),
        renderPasses: asStringArray(shot.renderPasses).length
          ? asStringArray(shot.renderPasses)
          : ["beauty", "depth", "normal", "mask", "motion-vector"],
        forbiddenMoves: asStringArray(shot.forbiddenMoves).length
          ? asStringArray(shot.forbiddenMoves)
          : ["floating cards", "kinetic typography spam", "arbitrary 2D transforms"],
        prompt: String(
          shot.prompt ||
            `Generate a ${shot.shotType || "cinematic"} shot grounded in the reference frame at ${formatTimestamp(
              sourceFrame?.timestamp || 0
            )}.`
        )
      };
    }
  );

  const slopWarnings: SlopWarning[] = (Array.isArray(params.raw.slopWarnings) ? params.raw.slopWarnings : []).map(
    (warning, index) => ({
      rule: String(warning.rule || `Slop warning ${index + 1}`),
      whyItBreaksTaste: String(warning.whyItBreaksTaste || "It breaks physical causality or cinematic authority."),
      rejectIf: String(warning.rejectIf || "Reject if the generated shot feels like a presentation slide."),
      preferredMove: String(warning.preferredMove || "Use physically grounded camera, lighting, and material behavior.")
    })
  );

  return {
    styleBible,
    shotSpecs,
    codexPrompt: String(params.raw.codexPrompt || buildDefaultCodexPrompt(styleBible, shotSpecs, slopWarnings)),
    slopWarnings
  };
}

function buildDefaultCodexPrompt(styleBible: StyleBible, shotSpecs: ShotSpec[], slopWarnings: SlopWarning[]): string {
  return [
    "Build an automated cinematic product video generator, not a motion graphics deck generator.",
    "",
    `Reference thesis: ${styleBible.oneSentenceThesis}`,
    "",
    "Immutable taste rules:",
    ...styleBible.cinematicPrinciples.map((rule) => `- ${rule}`),
    ...slopWarnings.slice(0, 8).map((warning) => `- Reject ${warning.rule}: ${warning.preferredMove}`),
    "",
    "Core unit: a physically plausible shot with lens, rig, lighting, material, render passes, narration role, and edit intent.",
    "",
    "Implement a vertical slice with these shot specs:",
    ...shotSpecs.map(
      (shot) =>
        `- ${shot.id}: ${shot.shotType}. ${shot.purpose} Camera: ${shot.camera.lens}, ${shot.camera.rig}, ${shot.camera.movement}.`
    ),
    "",
    "Use Blender as the causal substrate, diffusion/img2img only as photographic finishing, and Remotion only for editorial assembly, restrained typography, audio, and export."
  ].join("\n");
}

export function renderStyleMarkdown(analysis: Omit<CinematicAnalysis, "styleMarkdown" | "shotSpecMarkdown" | "promptMarkdown">): {
  styleMarkdown: string;
  shotSpecMarkdown: string;
  promptMarkdown: string;
} {
  const { styleBible, shotSpecs, slopWarnings, codexPrompt } = analysis;
  const styleLines: string[] = [];
  styleLines.push("# Style Bible");
  styleLines.push("");
  styleLines.push(`## Thesis`);
  styleLines.push(styleBible.oneSentenceThesis);
  styleLines.push("");
  styleLines.push("## Reference Lineage");
  styleLines.push(...styleBible.referenceLineage.map((item) => `- ${item}`));
  styleLines.push("");
  styleLines.push("## Production Ontology");
  styleLines.push(styleBible.productionOntology);
  styleLines.push("");
  styleLines.push("## Cinematic Principles");
  styleLines.push(...styleBible.cinematicPrinciples.map((item) => `- ${item}`));
  styleLines.push("");
  styleLines.push("## Visual Language");
  for (const [key, value] of Object.entries(styleBible.visualLanguage)) {
    styleLines.push(`- ${key}: ${value}`);
  }
  styleLines.push("");
  styleLines.push("## Narration Language");
  styleLines.push(`Register: ${styleBible.narrationLanguage.register}`);
  styleLines.push("");
  styleLines.push("Syntax rules:");
  styleLines.push(...styleBible.narrationLanguage.syntaxRules.map((item) => `- ${item}`));
  styleLines.push("");
  styleLines.push("Opening patterns:");
  styleLines.push(...styleBible.narrationLanguage.openingPatterns.map((item) => `- ${item}`));
  styleLines.push("");
  styleLines.push("Forbidden phrases:");
  styleLines.push(...styleBible.narrationLanguage.forbiddenPhrases.map((item) => `- ${item}`));
  styleLines.push("");
  styleLines.push("Sample lines:");
  styleLines.push(...styleBible.narrationLanguage.sampleLines.map((item) => `- ${item}`));
  styleLines.push("");
  styleLines.push("## Shot Patterns");
  for (const pattern of styleBible.shotPatterns) {
    styleLines.push(`### ${pattern.name}`);
    styleLines.push(`Function: ${pattern.function}`);
    styleLines.push(`Visual grammar: ${pattern.visualGrammar}`);
    styleLines.push(`Evidence frames: ${pattern.evidenceFrameIndexes.join(", ") || "n/a"}`);
    styleLines.push(`Reuse notes: ${pattern.reuseNotes}`);
    styleLines.push("");
  }
  styleLines.push("## Transfer Rules");
  styleLines.push(...styleBible.transferRules.map((item) => `- ${item}`));

  const shotLines: string[] = ["# Shot Specs", ""];
  for (const shot of shotSpecs) {
    shotLines.push(`## ${shot.id} - ${shot.shotType}`);
    shotLines.push(`Source: ${shot.sourceFrameFile} at ${formatTimestamp(shot.sourceTimestamp)}`);
    shotLines.push(`Purpose: ${shot.purpose}`);
    shotLines.push(`Narration role: ${shot.narrationRole}`);
    shotLines.push(`Subject: ${shot.subject}`);
    shotLines.push(`Environment: ${shot.environment}`);
    shotLines.push(`Camera: ${shot.camera.lens}, ${shot.camera.focalLengthMm ?? "n/a"}mm, ${shot.camera.aperture}`);
    shotLines.push(`Rig: ${shot.camera.rig}`);
    shotLines.push(`Movement: ${shot.camera.movement}`);
    shotLines.push(`Focus: ${shot.camera.focusBehavior}`);
    shotLines.push(`Lighting: ${shot.lighting.setup}`);
    shotLines.push(`Materials: ${shot.materials.join(", ")}`);
    shotLines.push(`Composition: ${shot.composition}`);
    shotLines.push(`Remotion role: ${shot.remotionRole}`);
    shotLines.push(`Diffusion intent: ${shot.diffusionIntent}`);
    shotLines.push(`Render passes: ${shot.renderPasses.join(", ")}`);
    shotLines.push(`Forbidden moves: ${shot.forbiddenMoves.join(", ")}`);
    shotLines.push("");
    shotLines.push("Prompt:");
    shotLines.push(shot.prompt);
    shotLines.push("");
  }
  shotLines.push("## Slop Warnings");
  for (const warning of slopWarnings) {
    shotLines.push(`- ${warning.rule}: ${warning.whyItBreaksTaste} Reject if: ${warning.rejectIf} Prefer: ${warning.preferredMove}`);
  }

  return {
    styleMarkdown: styleLines.join("\n"),
    shotSpecMarkdown: shotLines.join("\n"),
    promptMarkdown: `# Codex / Claude Prompt\n\n${codexPrompt}\n`
  };
}

export async function analyzeCinematicGrammar(params: {
  client: OpenAI;
  model: string;
  metadataTitle: string;
  sourceUrl: string;
  transcriptText: string;
  frames: FrameAnalysis[];
}): Promise<CinematicAnalysis> {
  const frameEvidence = params.frames
    .map(
      (frame) =>
        `Frame ${frame.index + 1} (${formatTimestamp(frame.timestamp)}, file ${frame.fileName}): ${frame.description}\nTags: ${frame.labels.join(", ")}\nNearby transcript: ${frame.transcriptContext}`
    )
    .join("\n\n");

  const content: Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string; detail: "low" }
  > = [
    {
      type: "input_text",
      text:
        "You are a cinematic grammar compiler for coding agents. Analyze this reference video so Codex/Claude can generate serious, physically grounded, luxury-grade video systems instead of Remotion slide decks.\n\n" +
        "Return strict JSON with keys styleBible, shotSpecs, codexPrompt, slopWarnings. No markdown inside JSON except codexPrompt may contain newlines.\n\n" +
        "styleBible must include: title, oneSentenceThesis, referenceLineage, productionOntology, cinematicPrinciples, visualLanguage {camera,lensing,lighting,composition,colorPalette,materiality,motion,editing,typography,sound,performance}, narrationLanguage {register,syntaxRules,openingPatterns,forbiddenPhrases,sampleLines}, shotPatterns [{name,function,visualGrammar,evidenceFrameIndexes,reuseNotes}], transferRules.\n\n" +
        "shotSpecs must be Blender/Remotion-ready. Each item must include: id, sourceFrameIndex, sourceTimestamp, sourceFrameFile, shotType, purpose, narrationRole, subject, environment, camera {lens,focalLengthMm,aperture,rig,movement,durationSeconds,focusBehavior}, lighting {setup,key,fill,rim,practicals}, materials, composition, remotionRole, diffusionIntent, renderPasses, forbiddenMoves, prompt.\n\n" +
        "slopWarnings must include: rule, whyItBreaksTaste, rejectIf, preferredMove.\n\n" +
        "Do not merely caption the frames. Extract reusable production logic: ontology, causality, camera grammar, material grammar, narration register, edit pacing, typography discipline, and anti-slop validators. Treat the selected frames as evidence.\n\n" +
        `Video title: ${params.metadataTitle}\nSource: ${params.sourceUrl}\n\nFrame evidence:\n${frameEvidence}\n\nTranscript excerpt:\n${params.transcriptText.slice(0, 12000)}`
    }
  ];

  for (const frame of params.frames.slice(0, 12)) {
    const imageBuffer = await readFile(frame.path);
    content.push({
      type: "input_image",
      image_url: `data:image/jpeg;base64,${imageBuffer.toString("base64")}`,
      detail: "low"
    });
  }

  const response = await params.client.responses.create({
    model: params.model,
    text: { format: { type: "json_object" } },
    input: [
      {
        role: "user",
        content
      }
    ]
  });

  const raw = parseJsonObject<RawCinematicAnalysis>(response.output_text || "", {});
  const canonical = canonicalizeCinematicAnalysis({
    raw,
    title: params.metadataTitle || "Reference style",
    frames: params.frames
  });
  return {
    ...canonical,
    ...renderStyleMarkdown(canonical)
  };
}
