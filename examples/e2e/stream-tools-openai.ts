/**
 * Demonstrates `toolCallAccumulator` against a real streaming OpenAI call.
 *
 * Run with:
 *   OPENAI_API_KEY=sk-... npm run stream:openai
 */
import OpenAI from 'openai'
import { toolSchema, toolCallAccumulator } from '@the-arj/llmfort'

if (!process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY to run this example.')
  process.exit(1)
}

const openai = new OpenAI()

const weatherTool = toolSchema({
  name: 'get_weather',
  description: 'Get current weather for a city.',
  params: {
    city:  { type: 'string' as const, description: 'City name' },
    units: { type: 'string' as const, enum: ['c', 'f'], description: 'Temperature units' },
  },
}, 'openai')

async function main() {
  const acc = toolCallAccumulator('openai')

  const stream = await openai.chat.completions.create({
    model: 'gpt-5',
    stream: true,
    messages: [
      { role: 'system', content: 'Always call get_weather when asked about weather.' },
      { role: 'user',   content: 'What is the weather in Paris and Tokyo? Return Celsius.' },
    ],
    tools: [weatherTool] as any,
    tool_choice: 'auto',
  })

  for await (const chunk of stream) {
    const completed = acc.push(chunk)
    for (const call of completed) {
      console.log(`[completed] ${call.name}(${JSON.stringify(call.arguments)})`)
    }
    // Live UI hint — uncomment to see partial state during streaming.
    // const partial = acc.partial()
    // for (const p of partial) console.log(`  partial[${p.index}] ${p.name ?? '?'}: ${p.argumentsRaw}`)
  }

  for (const call of acc.flush()) {
    console.log(`[flush] ${call.name}(${JSON.stringify(call.arguments)})`)
  }
}

main().catch(err => {
  console.error('Unhandled error:', err)
  process.exit(1)
})
