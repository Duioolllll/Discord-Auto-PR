export function controlApiUrl(value = process.env.CONTROL_API_URL ?? 'http://127.0.0.1:3001') {
  try {
    const base = new URL(value);
    if (
      base.username ||
      base.password ||
      (base.protocol !== 'https:' &&
        !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)))
    )
      throw new Error();
    return base;
  } catch {
    throw new Error('CONTROL_API_CONFIG_INVALID');
  }
}
