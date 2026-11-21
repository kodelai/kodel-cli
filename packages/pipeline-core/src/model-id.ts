/**
 * What a model id may look like in a record, a config key or a node's `model`: the state is not redacted, so nothing
 * free-form. Kept apart from the usage records so that the code that decides (the registry) never imports a usage module.
 */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/;
