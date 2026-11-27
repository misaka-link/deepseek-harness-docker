const makeNode = (def = {}) => {
  const node = { ...def };
  for (const method of ['default', 'description', 'min', 'max', 'role', 'required', 'hidden']) {
    node[method] = () => node;
  }
  return node;
};

const Schema = {
  object: (shape = {}) => makeNode({ type: 'object', shape }),
  string: () => makeNode({ type: 'string' }),
  boolean: () => makeNode({ type: 'boolean' }),
  number: () => makeNode({ type: 'number' }),
  const: (value) => makeNode({ type: 'const', value }),
  union: (list = []) => makeNode({ type: 'union', list })
};

export default Schema;
export { Schema };
