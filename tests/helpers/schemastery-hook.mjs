const STUB_URL = new URL('./schemastery-mock.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/schemastery') {
    try {
      return await nextResolve(specifier, context);
    } catch {
      return { url: STUB_URL, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
