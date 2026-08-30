import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { readUnsubscribeToken, updateProductUpdatePreference } from '../lib/emailPreferences'

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}

function htmlResponse(status: number, title: string, message: string): HttpResponseInit {
    const safeTitle = escapeHtml(title)
    const safeMessage = escapeHtml(message)

    return {
        status,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        },
        body: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle} | Better Retirement</title>
</head>
<body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#263238">
  <main style="max-width:600px;margin:64px auto;padding:32px;background:#fff;border-radius:12px">
    <h1 style="margin-top:0;color:#156b5d">${safeTitle}</h1>
    <p style="line-height:1.6">${safeMessage}</p>
    <p><a href="https://better-retirement.com" style="color:#156b5d">Return to Better Retirement</a></p>
  </main>
</body>
</html>`
    }
}

function confirmationResponse(token: string): HttpResponseInit {
    const action = `/api/email/unsubscribe?token=${encodeURIComponent(token)}`

    return {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        },
        body: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unsubscribe | Better Retirement</title>
</head>
<body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#263238">
  <main style="max-width:600px;margin:64px auto;padding:32px;background:#fff;border-radius:12px">
    <h1 style="margin-top:0;color:#156b5d">Unsubscribe from product updates?</h1>
    <p style="line-height:1.6">You will stop receiving Better Retirement product updates and announcements. You can re-subscribe later from your account menu.</p>
    <form method="post" action="${action}">
      <button type="submit" style="border:0;border-radius:6px;padding:12px 18px;background:#156b5d;color:#fff;font-size:16px;cursor:pointer">Unsubscribe</button>
    </form>
  </main>
</body>
</html>`
    }
}

export async function unsubscribeEmail(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    if (request.method !== 'GET' && request.method !== 'POST') {
        return htmlResponse(405, 'Method not allowed', 'Use the unsubscribe link from your email.')
    }

    const token = request.query.get('token') || ''

    try {
        const email = readUnsubscribeToken(token)

        if (request.method === 'GET') {
            return confirmationResponse(token)
        }

        await updateProductUpdatePreference(email, false, 'email-unsubscribe')
        return htmlResponse(
            200,
            'You are unsubscribed',
            'You will no longer receive Better Retirement product updates. You can subscribe again from your account menu.'
        )
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown unsubscribe error.'
        context.warn(`Email unsubscribe failed: ${message}`)
        return htmlResponse(
            400,
            'This link did not work',
            'The unsubscribe link is invalid. Sign in to Better Retirement to update your email preferences.'
        )
    }
}

app.http('unsubscribe-email', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    route: 'email/unsubscribe',
    handler: unsubscribeEmail
})
