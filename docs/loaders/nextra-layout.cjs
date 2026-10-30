// Nextra 4.6.1 removes children before validating a schema that requires it.
// Apply the upstream fix while bundling, without changing installed files.
// Remove this loader after upgrading to a release that includes the fix.
// https://github.com/shuding/nextra/issues/5008
module.exports = function fixNextraLayout(source) {
  const before = 'LayoutPropsSchema.safeParse(themeConfig)';
  const after = 'LayoutPropsSchema.safeParse({ children, ...themeConfig })';
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error('Nextra Layout changed; review the compatibility loader.');
  return source.replace(before, after);
};
