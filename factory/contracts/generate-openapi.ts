import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { confirmationRequiredSchema, routes, type Body, type Route } from './routes.ts';
import { problemDetailsSchema } from './schemas/index.ts';

function content(body: Body) {
  if (body === 'none') return {};
  if (body === 'unspecified') return { content: { 'application/json': { schema: { 'x-body-unspecified': true } } } };
  if (body === 'binary') return { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
  if (body === 'text' || body === 'event-stream') return { content: { [body === 'text' ? 'text/plain' : 'text/event-stream']: { schema: { type: 'string' } } } };
  return { content: { 'application/json': { schema: z.toJSONSchema(body) } } };
}

export function generateOpenApi(table: readonly Route[] = routes): string {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of table) {
    const responses: Record<string, unknown> = {};
    for (const [status, body] of Object.entries(route.responses)) {
      if (route.errors[Number(status)]) continue;
      responses[status] = { description: 'Response', ...content(body) };
    }
    for (const [status, codes] of Object.entries(route.errors)) {
      const errorSchema = codes.includes('confirmation_required')
        ? { anyOf: [{ $ref: '#/components/schemas/ProblemDetails' }, { $ref: '#/components/schemas/ConfirmationRequired' }] }
        : { $ref: '#/components/schemas/ProblemDetails' };
      responses[status] = { description: 'Error', 'x-error-codes': codes,
        content: { 'application/problem+json': { schema: errorSchema } } };
    }
    const pathParameters = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      name: match[1], in: 'path', required: true, schema: { type: 'string' },
    }));
    const parameters = [...pathParameters, ...route.parameters.map(({ repeatable, schema, ...parameter }) => ({
      ...parameter, ...(repeatable ? { style: 'form', explode: true, schema: { type: 'array', items: schema ? z.toJSONSchema(schema) : { type: 'string' } } } : { schema: schema ? z.toJSONSchema(schema) : { type: 'string' } }),
    }))];
    const operations = paths[route.path] ??= {};
    operations[route.method.toLowerCase()] = {
      operationId: route.operationId,
      'x-roles': route.roles,
      'x-idempotent': route.idempotent,
      ...(parameters.length ? { parameters } : {}),
      ...(route.request === 'none' ? {} : { requestBody: { ...(route.request === 'unspecified' ? {} : { required: true }), ...content(route.request) } }),
      responses,
    };
  }
  return `${JSON.stringify({ openapi: '3.1.0', info: { title: 'Agent Factory API', version: '1.0.0' }, paths,
    components: { schemas: { ProblemDetails: z.toJSONSchema(problemDetailsSchema), ConfirmationRequired: z.toJSONSchema(confirmationRequiredSchema) } } }, null, 2)}\n`;
}

export function generateOpenApiQuestions(table: readonly Route[] = routes): string {
  const requests = table.filter((route) => route.request === 'unspecified')
    .map((route) => `- \`${route.method} ${route.path}\``);
  const responses = table.flatMap((route) => Object.entries(route.responses)
    .filter(([, body]) => body === 'unspecified')
    .map(([status]) => `- \`${route.method} ${route.path}\` — ${status}`));
  return ['# Unspecified API bodies', '', 'The API document leaves these complete shapes open for their handler packages.',
    '', '## Requests', '', ...requests, '', '## Responses', '', ...responses, ''].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeFile(new URL('./openapi.json', import.meta.url), generateOpenApi());
  await writeFile(new URL('./openapi-questions.md', import.meta.url), generateOpenApiQuestions());
}
