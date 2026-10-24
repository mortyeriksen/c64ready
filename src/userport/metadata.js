// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { parse } from 'acorn';

// Inspect declarations without evaluating the module, getters or expressions.
export function readDeviceExports(source) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const declarations = new Map(), exports = new Map();
  function remember(node) {
    if (node?.type === 'VariableDeclaration') {
      for (const binding of node.declarations) if (binding.id.type === 'Identifier') declarations.set(binding.id.name, binding.init);
    } else if (node?.type === 'FunctionDeclaration') declarations.set(node.id.name, node);
  }
  for (const node of tree.body) {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.source)
      throw new Error('Bundle plugin imports into one file before installing.');
    if (node.type === 'ExportNamedDeclaration') {
      remember(node.declaration);
      if (node.declaration?.type === 'VariableDeclaration') {
        for (const binding of node.declaration.declarations) if (binding.id.type === 'Identifier') exports.set(binding.id.name, binding.id.name);
      } else if (node.declaration?.type === 'FunctionDeclaration') exports.set(node.declaration.id.name, node.declaration.id.name);
      for (const item of node.specifiers) if (!node.source) exports.set(item.exported.name || item.exported.value, item.local.name);
    } else remember(node);
  }
  function resolve(node, depth = 0) {
    if (depth > 20) throw new Error('Plugin metadata is too deeply nested.');
    if (node?.type === 'Identifier') return resolve(declarations.get(node.name), depth + 1);
    return node;
  }
  function constant(node, depth = 0) {
    if (depth > 20) throw new Error('Plugin metadata is too deeply nested.');
    node = resolve(node, depth);
    if (node?.type === 'Literal' && !node.regex && typeof node.value !== 'bigint') return node.value;
    if (node?.type === 'UnaryExpression' && ['+', '-'].includes(node.operator) && node.argument.type === 'Literal' && typeof node.argument.value === 'number')
      return node.operator === '-' ? -node.argument.value : node.argument.value;
    if (node?.type === 'ObjectExpression') {
      const value = Object.create(null);
      for (const property of node.properties) {
        if (property.type !== 'Property' || property.kind !== 'init' || property.method || property.computed)
          throw new Error('Plugin metadata must contain constant properties.');
        value[property.key.name ?? property.key.value] = constant(property.value, depth + 1);
      }
      return value;
    }
    throw new Error('Plugin metadata must use constant values.');
  }
  const meta = exports.has('meta') ? constant(declarations.get(exports.get('meta'))) : undefined;
  const create = resolve(declarations.get(exports.get('create')));
  return { meta, hasCreate: ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(create?.type) };
}
