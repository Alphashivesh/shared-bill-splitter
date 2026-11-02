import { createFileRoute } from '@tanstack/react-router'
import { type FormEvent, useCallback, useEffect, useState } from 'react'

type Member = {
  id: string
  homeId: string
  name: string
}

type Share = {
  id: string
  memberId: string
  amountCents: number
  paidAt: string | null
}

type Bill = {
  id: string
  homeId: string
  title: string
  totalCents: number
  shares: Share[]
}

type Balance = {
  memberId: string
  name: string
  outstandingCents: number
}

type HomeDetails = {
  id: string
  name: string
  members: Member[]
  bills: Bill[]
}

function isErrorPayload(value: unknown): value is { error: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error: unknown }).error === 'string'
  )
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

async function safeRequest<T>(
  url: string,
  options?: RequestInit,
): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
      },
    })

    const body: unknown = await response.json().catch(() => null)

    if (!response.ok) {
      if (isErrorPayload(body)) {
        return { data: null, error: body.error }
      }
      return {
        data: null,
        error: `Request failed with status ${response.status}`,
      }
    }

    return { data: body as T, error: null }
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Network error — please check your connection.',
    }
  }
}

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const [homeId, setHomeId] = useState<string | null>(() =>
    localStorage.getItem('bill_splitter_home_id'),
  )
  const [home, setHome] = useState<HomeDetails | null>(null)
  const [balances, setBalances] = useState<Balance[]>([])
  const [isLoadingHome, setIsLoadingHome] = useState<boolean>(false)
  const [pageError, setPageError] = useState<string | null>(null)

  const [newHomeName, setNewHomeName] = useState('')
  const [newMemberName, setNewMemberName] = useState('')
  const [billTitle, setBillTitle] = useState('')
  const [billTotalCents, setBillTotalCents] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const [payingShareIds, setPayingShareIds] = useState<Record<string, boolean>>({})
  const [shareErrors, setShareErrors] = useState<Record<string, string>>({})
  const [idempotencyKeys, setIdempotencyKeys] = useState<Record<string, string>>({})

  const loadHomeData = useCallback(async (targetHomeId: string) => {
    setIsLoadingHome(true)
    setPageError(null)

    const [homeRes, balancesRes] = await Promise.all([
      safeRequest<HomeDetails>(`/api/homes/${targetHomeId}`),
      safeRequest<{ balances: Balance[] }>(`/api/homes/${targetHomeId}/balances`),
    ])

    if (homeRes.error || !homeRes.data) {
      setPageError(homeRes.error ?? 'Failed to load home')
      setIsLoadingHome(false)
      return
    }

    if (balancesRes.error || !balancesRes.data) {
      setPageError(balancesRes.error ?? 'Failed to load balances')
      setIsLoadingHome(false)
      return
    }

    setHome(homeRes.data)
    setBalances(balancesRes.data.balances)
    setIsLoadingHome(false)
  }, [])

  useEffect(() => {
    if (homeId) {
      void loadHomeData(homeId)
    }
  }, [homeId, loadHomeData])

  const handleCreateHome = async (e: FormEvent) => {
    e.preventDefault()
    setActionError(null)
    setIsSubmitting(true)

    const { data, error } = await safeRequest<{ id: string; name: string }>('/api/homes', {
      method: 'POST',
      body: JSON.stringify({ name: newHomeName }),
    })

    setIsSubmitting(false)
    if (error || !data) {
      setActionError(error ?? 'Could not create home')
      return
    }

    localStorage.setItem('bill_splitter_home_id', data.id)
    setNewHomeName('')
    setHomeId(data.id)
  }

  const handleAddMember = async (e: FormEvent) => {
    e.preventDefault()
    if (!homeId) return
    setActionError(null)
    setIsSubmitting(true)

    const { error } = await safeRequest(`/api/homes/${homeId}/members`, {
      method: 'POST',
      body: JSON.stringify({ name: newMemberName }),
    })

    setIsSubmitting(false)
    if (error) {
      setActionError(error)
      return
    }

    setNewMemberName('')
    await loadHomeData(homeId)
  }

  const handleCreateBill = async (e: FormEvent) => {
    e.preventDefault()
    if (!homeId) return
    setActionError(null)

    const parsedCents = Number(billTotalCents)
    setIsSubmitting(true)

    const { error } = await safeRequest(`/api/homes/${homeId}/bills`, {
      method: 'POST',
      body: JSON.stringify({
        title: billTitle,
        totalCents: parsedCents,
      }),
    })

    setIsSubmitting(false)
    if (error) {
      setActionError(error)
      return
    }

    setBillTitle('')
    setBillTotalCents('')
    await loadHomeData(homeId)
  }

  const handlePayShare = async (billId: string, shareId: string) => {
    if (!homeId || payingShareIds[shareId]) return

    setShareErrors((prev) => {
      const next = { ...prev }
      delete next[shareId]
      return next
    })

    const key = idempotencyKeys[shareId] ?? crypto.randomUUID()
    if (!idempotencyKeys[shareId]) {
      setIdempotencyKeys((prev) => ({ ...prev, [shareId]: key }))
    }

    setPayingShareIds((prev) => ({ ...prev, [shareId]: true }))

    const { data, error } = await safeRequest<Share>(`/api/bills/${billId}/shares/${shareId}/pay`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': key,
      },
    })

    setPayingShareIds((prev) => ({ ...prev, [shareId]: false }))

    if (error || !data) {
      setShareErrors((prev) => ({
        ...prev,
        [shareId]: error ?? 'Payment failed. Please try again.',
      }))
      return
    }

    await loadHomeData(homeId)
  }

  const memberNameById = new Map(home?.members.map((m) => [m.id, m.name]) ?? [])

  return (
    <main
      style={{
        maxWidth: 840,
        margin: '0 auto',
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1>Shared Bill Splitter</h1>

      {actionError && (
        <div
          role="alert"
          style={{
            background: '#fee2e2',
            color: '#991b1b',
            padding: '0.75rem 1rem',
            borderRadius: 6,
            marginBottom: '1rem',
          }}
        >
          <strong>Error:</strong> {actionError}
        </div>
      )}

      {!homeId ? (
        <section
          style={{
            padding: '1rem',
            border: '1px solid #e5e7eb',
            borderRadius: 8,
          }}
        >
          <h2>Create a Home</h2>
          <form
            onSubmit={(e) => void handleCreateHome(e)}
            style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}
          >
            <input
              type="text"
              placeholder="Home name (e.g. Maple House)"
              value={newHomeName}
              onChange={(e) => setNewHomeName(e.target.value)}
              required
              style={{ padding: '0.5rem' }}
            />
            <button type="submit" disabled={isSubmitting} style={{ padding: '0.5rem 1rem' }}>
              {isSubmitting ? 'Creating...' : 'Create Home'}
            </button>
          </form>
        </section>
      ) : isLoadingHome && !home ? (
        <p aria-live="polite">Loading home and bills...</p>
      ) : pageError ? (
        <div
          role="alert"
          style={{
            background: '#fee2e2',
            color: '#991b1b',
            padding: '1rem',
            borderRadius: 6,
          }}
        >
          <p>Could not load home: {pageError}</p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              onClick={() => void loadHomeData(homeId)}
              style={{ padding: '0.4rem 0.8rem' }}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => {
                localStorage.removeItem('bill_splitter_home_id')
                setHomeId(null)
                setHome(null)
              }}
              style={{ padding: '0.4rem 0.8rem' }}
            >
              Create New Home
            </button>
          </div>
        </div>
      ) : home ? (
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem',
            }}
          >
            <h2 style={{ margin: 0 }}>Home: {home.name}</h2>
            <button
              type="button"
              onClick={() => {
                localStorage.removeItem('bill_splitter_home_id')
                setHomeId(null)
                setHome(null)
              }}
              style={{ padding: '0.4rem 0.8rem' }}
            >
              Switch / New Home
            </button>
          </div>

          <section
            style={{
              marginBottom: '1.5rem',
              padding: '1rem',
              border: '1px solid #e5e7eb',
              borderRadius: 8,
            }}
          >
            <h3 style={{ marginTop: 0 }}>Members & Outstanding Balances</h3>
            {balances.length === 0 ? (
              <p>No members yet. Add members below before splitting a bill.</p>
            ) : (
              <ul>
                {balances.map((b) => (
                  <li key={b.memberId} style={{ marginBottom: 4 }}>
                    <strong>{b.name}</strong> — Outstanding:{' '}
                    <span>{formatCents(b.outstandingCents)}</span> ({b.outstandingCents} cents)
                  </li>
                ))}
              </ul>
            )}

            <form
              onSubmit={(e) => void handleAddMember(e)}
              style={{
                display: 'flex',
                gap: '0.5rem',
                marginTop: '0.75rem',
                flexWrap: 'wrap',
              }}
            >
              <input
                type="text"
                placeholder="Member name (e.g. Alice)"
                value={newMemberName}
                onChange={(e) => setNewMemberName(e.target.value)}
                required
                style={{ padding: '0.4rem 0.6rem' }}
              />
              <button type="submit" disabled={isSubmitting} style={{ padding: '0.4rem 0.8rem' }}>
                Add Member
              </button>
            </form>
          </section>

          <section
            style={{
              marginBottom: '1.5rem',
              padding: '1rem',
              border: '1px solid #e5e7eb',
              borderRadius: 8,
            }}
          >
            <h3 style={{ marginTop: 0 }}>Add a Bill</h3>
            <form
              onSubmit={(e) => void handleCreateBill(e)}
              style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}
            >
              <input
                type="text"
                placeholder="Bill title (e.g. Internet)"
                value={billTitle}
                onChange={(e) => setBillTitle(e.target.value)}
                required
                style={{ padding: '0.4rem 0.6rem' }}
              />
              <input
                type="number"
                placeholder="Total in cents (e.g. 1000)"
                value={billTotalCents}
                onChange={(e) => setBillTotalCents(e.target.value)}
                required
                style={{ padding: '0.4rem 0.6rem' }}
              />
              <button type="submit" disabled={isSubmitting} style={{ padding: '0.4rem 0.8rem' }}>
                Split Bill
              </button>
            </form>
          </section>

          <section>
            <h3>Bills</h3>
            {home.bills.length === 0 ? (
              <p>No bills added for this home yet.</p>
            ) : (
              home.bills.map((bill) => (
                <article
                  key={bill.id}
                  style={{
                    border: '1px solid #d1d5db',
                    borderRadius: 8,
                    padding: '1rem',
                    marginBottom: '1rem',
                  }}
                >
                  <header
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: '0.5rem',
                    }}
                  >
                    <strong>{bill.title}</strong>
                    <span>
                      Total: {formatCents(bill.totalCents)} ({bill.totalCents} cents)
                    </span>
                  </header>

                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr
                        style={{
                          textAlign: 'left',
                          borderBottom: '1px solid #e5e7eb',
                        }}
                      >
                        <th style={{ padding: '0.5rem' }}>Member</th>
                        <th style={{ padding: '0.5rem' }}>Share</th>
                        <th style={{ padding: '0.5rem' }}>Status</th>
                        <th style={{ padding: '0.5rem' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bill.shares.map((share) => {
                        const isPaying = Boolean(payingShareIds[share.id])
                        const shareError = shareErrors[share.id]
                        const paidAt = share.paidAt

                        return (
                          <tr key={share.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '0.5rem' }}>
                              {memberNameById.get(share.memberId) ?? share.memberId}
                            </td>
                            <td style={{ padding: '0.5rem' }}>
                              {formatCents(share.amountCents)} ({share.amountCents} cents)
                            </td>
                            <td style={{ padding: '0.5rem' }}>
                              {paidAt !== null ? (
                                <span
                                  style={{
                                    color: '#15803d',
                                    fontWeight: 600,
                                  }}
                                >
                                  Paid ({new Date(paidAt).toLocaleTimeString()})
                                </span>
                              ) : (
                                <span style={{ color: '#b45309' }}>Unpaid</span>
                              )}
                              {shareError && (
                                <div
                                  role="alert"
                                  style={{
                                    color: '#b91c1c',
                                    fontSize: '0.85rem',
                                    marginTop: 4,
                                  }}
                                >
                                  {shareError}
                                </div>
                              )}
                            </td>
                            <td style={{ padding: '0.5rem' }}>
                              {paidAt === null && (
                                <button
                                  type="button"
                                  disabled={isPaying}
                                  onClick={() => void handlePayShare(bill.id, share.id)}
                                  style={{ padding: '0.3rem 0.6rem' }}
                                >
                                  {isPaying ? 'Paying...' : 'Pay Share'}
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </article>
              ))
            )}
          </section>
        </div>
      ) : null}
    </main>
  )
}
