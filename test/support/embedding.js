/**
 * A deterministic stand-in for an embedding model. Texts that mention a word
 * from the same group get the same vector; anything else gets its own. That
 * makes similarity exactly predictable, so a test can assert what the
 * vocabulary DOES with meaning without depending on a model's judgment of it.
 */
export function fixtureEmbedding(groups) {
  const spare = 8;
  const dimensions = groups.length + spare;
  return {
    model: 'fixture', dimensions, calls: 0,
    async embed(texts) {
      this.calls += 1;
      return texts.map(text => {
        const value = String(text);
        const group = groups.findIndex(words => words.some(word => value.includes(word)));
        const vector = new Array(dimensions).fill(0);
        let hash = 7;
        for (const char of value) hash = (hash * 31 + char.codePointAt(0)) % 1000003;
        vector[group === -1 ? groups.length + (hash % spare) : group] = 1;
        return vector;
      });
    },
  };
}
