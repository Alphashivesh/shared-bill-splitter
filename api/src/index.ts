import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

type HomeRow = {
  id: string
  name: string
}

type MemberRow = {
  id: string
  homeId: string
  name: string
}

type BillRow = {
  id: string
  homeId: string
  title: string
  totalCents: number
}

type ShareRow = {
  id: string
  billId: string
  memberId: string
  amountCents: number
  paidAt: string | null
  idempotencyKey: string | null
}

type ShareWebRow = {
  id: string
  billId: string
  memberId: string
  amountCents: number
  paidAt: string | null
}

type BalanceRow = {
  memberId: string
  name: string
  outstandingCents: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function parseJsonBody(c: {
  req: { json: () => Promise<unknown> }
}): Promise<Record<string, unknown> | null> {
  try {
    const data: unknown = await c.req.json()
    return isRecord(data) ? data : null
  } catch {
    return null
  }
}

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ error: 'Internal server error' }, 500)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

// POST /api/homes
app.post('/api/homes', async (c) => {
  const body = await parseJsonBody(c)
  if (!body || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json({ error: 'A non-empty home name is required' }, 400)
  }

  const id = crypto.randomUUID()
  const name = body.name.trim()

  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?1, ?2)').bind(id, name).run()

  return c.json({ id, name }, 201)
})

// GET /api/homes/:homeId
app.get('/api/homes/:homeId', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id, name FROM homes WHERE id = ?1')
    .bind(homeId)
    .first<HomeRow>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const [membersResult, billsResult, sharesResult] = await c.env.DB.batch([
    c.env.DB.prepare(
      'SELECT id, home_id AS homeId, name FROM members WHERE home_id = ?1 ORDER BY rowid ASC',
    ).bind(homeId),
    c.env.DB.prepare(
      'SELECT id, home_id AS homeId, title, total_cents AS totalCents FROM bills WHERE home_id = ?1 ORDER BY rowid DESC',
    ).bind(homeId),
    c.env.DB.prepare(
      `SELECT
         s.id,
         s.bill_id AS billId,
         s.member_id AS memberId,
         s.amount_cents AS amountCents,
         s.paid_at AS paidAt
       FROM shares s
       INNER JOIN bills b ON b.id = s.bill_id
       INNER JOIN members m ON m.id = s.member_id
       WHERE b.home_id = ?1
       ORDER BY m.rowid ASC`,
    ).bind(homeId),
  ])

  const members = (membersResult?.results ?? []) as unknown as MemberRow[]
  const bills = (billsResult?.results ?? []) as unknown as BillRow[]
  const allShares = (sharesResult?.results ?? []) as unknown as ShareWebRow[]

  const billsWithShares = bills.map((bill: BillRow) => ({
    id: bill.id,
    homeId: bill.homeId,
    title: bill.title,
    totalCents: bill.totalCents,
    shares: allShares
      .filter((s: ShareWebRow) => s.billId === bill.id)
      .map((s: ShareWebRow) => ({
        id: s.id,
        memberId: s.memberId,
        amountCents: s.amountCents,
        paidAt: s.paidAt,
      })),
  }))

  return c.json({
    id: home.id,
    name: home.name,
    members,
    bills: billsWithShares,
  })
})

// POST /api/homes/:homeId/members
app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const body = await parseJsonBody(c)

  if (!body || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json({ error: 'A non-empty member name is required' }, 400)
  }

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?1')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const id = crypto.randomUUID()
  const name = body.name.trim()

  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?1, ?2, ?3)')
    .bind(id, homeId, name)
    .run()

  return c.json({ id, homeId, name }, 201)
})

// POST /api/homes/:homeId/bills
app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const body = await parseJsonBody(c)

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?1')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  if (!body || typeof body.title !== 'string' || body.title.trim().length === 0) {
    return c.json({ error: 'A non-empty bill title is required' }, 422)
  }

  const totalCents = body.totalCents
  if (typeof totalCents !== 'number' || !Number.isSafeInteger(totalCents) || totalCents <= 0) {
    return c.json({ error: 'totalCents must be a positive whole number' }, 422)
  }

  const membersResult = await c.env.DB.prepare(
    'SELECT id, home_id AS homeId, name FROM members WHERE home_id = ?1 ORDER BY rowid ASC',
  )
    .bind(homeId)
    .all<MemberRow>()

  const members = membersResult.results as MemberRow[]
  if (members.length === 0) {
    return c.json({ error: 'Home has no members' }, 422)
  }

  const billId = crypto.randomUUID()
  const title = body.title.trim()
  const memberCount = members.length
  const baseShare = Math.floor(totalCents / memberCount)
  const remainder = totalCents % memberCount

  const shares = members.map((member: MemberRow, index: number) => ({
    id: crypto.randomUUID(),
    memberId: member.id,
    amountCents: baseShare + (index < remainder ? 1 : 0),
    paidAt: null as string | null,
  }))

  const statements = [
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?1, ?2, ?3, ?4)',
    ).bind(billId, homeId, title, totalCents),
    ...shares.map(
      (share: { id: string; memberId: string; amountCents: number; paidAt: string | null }) =>
        c.env.DB.prepare(
          'INSERT INTO shares (id, bill_id, member_id, amount_cents, paid_at, idempotency_key) VALUES (?1, ?2, ?3, ?4, NULL, NULL)',
        ).bind(share.id, billId, share.memberId, share.amountCents),
    ),
  ]

  await c.env.DB.batch(statements)

  return c.json(
    {
      id: billId,
      homeId,
      title,
      totalCents,
      shares,
    },
    201,
  )
})

// POST /api/bills/:billId/shares/:shareId/pay
app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const rawKey = c.req.header('Idempotency-Key')
  const idempotencyKey = rawKey?.trim()

  if (!idempotencyKey) {
    return c.json({ error: 'Idempotency-Key header is required' }, 400)
  }

  const nowIso = new Date().toISOString()

  const updated = await c.env.DB.prepare(
    `UPDATE shares
     SET paid_at = ?1, idempotency_key = ?2
     WHERE id = ?3 AND bill_id = ?4 AND paid_at IS NULL
     RETURNING id, member_id AS memberId, amount_cents AS amountCents, paid_at AS paidAt`,
  )
    .bind(nowIso, idempotencyKey, shareId, billId)
    .first<{
      id: string
      memberId: string
      amountCents: number
      paidAt: string
    }>()

  if (updated) {
    return c.json(updated, 200)
  }

  const existing = await c.env.DB.prepare(
    `SELECT
       id,
       bill_id AS billId,
       member_id AS memberId,
       amount_cents AS amountCents,
       paid_at AS paidAt,
       idempotency_key AS idempotencyKey
     FROM shares
     WHERE id = ?1 AND bill_id = ?2`,
  )
    .bind(shareId, billId)
    .first<ShareRow>()

  if (!existing) {
    return c.json({ error: 'Bill or share not found' }, 404)
  }

  if (existing.idempotencyKey === idempotencyKey) {
    return c.json(
      {
        id: existing.id,
        memberId: existing.memberId,
        amountCents: existing.amountCents,
        paidAt: existing.paidAt,
      },
      200,
    )
  }

  return c.json({ error: 'Share already paid with a different key' }, 409)
})

// GET /api/homes/:homeId/balances
app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?1')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const balancesResult = await c.env.DB.prepare(
    `SELECT
       m.id AS memberId,
       m.name AS name,
       COALESCE(
         SUM(CASE WHEN s.id IS NOT NULL AND s.paid_at IS NULL THEN s.amount_cents ELSE 0 END),
         0
       ) AS outstandingCents
     FROM members m
     LEFT JOIN shares s ON s.member_id = m.id
     WHERE m.home_id = ?1
     GROUP BY m.id, m.name, m.rowid
     ORDER BY m.rowid ASC`,
  )
    .bind(homeId)
    .all<BalanceRow>()

  const balances = (balancesResult.results as BalanceRow[]).map((row: BalanceRow) => ({
    memberId: row.memberId,
    name: row.name,
    outstandingCents: Number(row.outstandingCents),
  }))

  return c.json({ balances }, 200)
})

export default app
