/** Display names of the writer arms stored on a draft or a post (`arm`): the class log, the review and the charts. */
export const ARM_LABEL: Record<string, string> = {
  sol: "GPT-6.1 Sol",
  luna: "GPT-6 Luna",
  glm: "GLM Flash",
};

/** Display name of a model id as the calls and the system status store it; an unknown id is shown as it is. */
export function modelLabel(model: string): string {
  if (model.startsWith("z-ai/glm")) return "GLM Flash";
  if (model.startsWith("openai/gpt-6.1-sol")) return "GPT-6.1 Sol";
  if (model.startsWith("openai/gpt-6-luna")) return "GPT-6 Luna";
  if (model.startsWith("stt-async")) return "Soniox transcription";
  return model;
}

/** Reasoning efforts as "medium + high": the judge runs at every one of them. */
export function effortsLabel(efforts: readonly string[]): string {
  return efforts.join(" + ");
}
