/**
 * api/ff-introspect.js
 * Temporary endpoint — introspects the Fireflies GraphQL schema to find
 * the exact addToLiveMeeting argument names and return field names.
 * Visit: /api/ff-introspect
 * DELETE this file once the correct schema is confirmed.
 */

export default async function handler(req, res) {
    const apiKey = process.env.FIREFLIES_API_KEY;
    if (!apiKey) return res.status(500).send('FIREFLIES_API_KEY not set');

    // Ask GraphQL for the exact shape of addToLiveMeeting
    const introspection = `
        {
            __type(name: "Mutation") {
                fields {
                    name
                    args { name type { name kind ofType { name kind } } }
                    type { name kind fields { name type { name kind } } }
                }
            }
        }
    `;

    const r = await fetch('https://api.fireflies.ai/graphql', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: introspection }),
    });

    const data = await r.json();

    // Filter to just the addToLiveMeeting field
    const fields = data?.data?.__type?.fields || [];
    const field = fields.find(f => f.name === 'addToLiveMeeting') || { error: 'not found', all: fields.map(f => f.name) };

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(field);
}
