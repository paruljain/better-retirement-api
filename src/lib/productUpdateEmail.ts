import { EmailClient, EmailMessage } from '@azure/communication-email'
import { createUnsubscribeToken, normalizeEmailAddress } from './emailPreferences'

type ProductUpdateEmailOptions = {
    recipient: string
    subject: string
    markdown: string
    senderAddress: string
    replyToAddress?: string
    publicApiBaseUrl: string
    postalAddress?: string
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}

function renderInlineMarkdown(value: string): string {
    return escapeHtml(value)
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" style="color:#156b5d">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

export function renderMessageMarkdown(markdown: string): string {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n')
    const blocks: string[] = []
    let paragraph: string[] = []
    let listItems: string[] = []

    function flushParagraph() {
        if (paragraph.length) {
            blocks.push(`<p style="margin:0 0 18px;line-height:1.65">${paragraph.map(renderInlineMarkdown).join('<br>')}</p>`)
            paragraph = []
        }
    }

    function flushList() {
        if (listItems.length) {
            blocks.push(`<ul style="margin:0 0 18px;padding-left:24px;line-height:1.65">${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</ul>`)
            listItems = []
        }
    }

    for (const line of lines) {
        const trimmed = line.trim()

        if (!trimmed) {
            flushParagraph()
            flushList()
        } else if (trimmed.startsWith('- ')) {
            flushParagraph()
            listItems.push(trimmed.slice(2))
        } else if (trimmed.startsWith('## ')) {
            flushParagraph()
            flushList()
            blocks.push(`<h2 style="margin:26px 0 12px;color:#156b5d;font-size:20px">${renderInlineMarkdown(trimmed.slice(3))}</h2>`)
        } else if (trimmed.startsWith('# ')) {
            flushParagraph()
            flushList()
            blocks.push(`<h1 style="margin:0 0 18px;color:#156b5d;font-size:26px">${renderInlineMarkdown(trimmed.slice(2))}</h1>`)
        } else {
            flushList()
            paragraph.push(trimmed)
        }
    }

    flushParagraph()
    flushList()
    return blocks.join('\n')
}

export function buildProductUpdateEmail(options: ProductUpdateEmailOptions): EmailMessage {
    const recipient = normalizeEmailAddress(options.recipient)
    const publicApiBaseUrl = options.publicApiBaseUrl.replace(/\/+$/, '')
    const unsubscribeToken = createUnsubscribeToken(recipient)
    const unsubscribeUrl = `${publicApiBaseUrl}/api/email/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`
    const htmlBody = renderMessageMarkdown(options.markdown)
    const postalAddress = options.postalAddress?.trim() || ''
    const safePostalAddress = escapeHtml(postalAddress)
    const plainTextSender = postalAddress
        ? `Better Retirement\n${postalAddress}`
        : 'Better Retirement'
    const htmlSender = postalAddress
        ? `Better Retirement · ${safePostalAddress}`
        : 'Better Retirement'
    const message: EmailMessage = {
        senderAddress: options.senderAddress,
        content: {
            subject: options.subject,
            plainText: `${options.markdown.trim()}\n\n---\n${plainTextSender}\nUnsubscribe: ${unsubscribeUrl}`,
            html: `<!doctype html>
<html lang="en">
<body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#263238">
  <div style="display:none;max-height:0;overflow:hidden">${escapeHtml(options.subject)}</div>
  <main style="max-width:640px;margin:0 auto;padding:32px 18px">
    <section style="background:#fff;border-radius:12px;padding:32px">
      <div style="font-size:22px;font-weight:700;color:#156b5d;margin-bottom:28px">Better Retirement</div>
      ${htmlBody}
    </section>
    <footer style="padding:22px 12px;text-align:center;color:#687477;font-size:12px;line-height:1.6">
      <div>${htmlSender}</div>
      <div><a href="${unsubscribeUrl}" style="color:#52666a">Unsubscribe from product updates</a></div>
    </footer>
  </main>
</body>
</html>`
        },
        recipients: {
            to: [{ address: recipient }]
        },
        headers: {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        },
        disableUserEngagementTracking: true
    }

    if (options.replyToAddress) {
        message.replyTo = [{ address: options.replyToAddress }]
    }

    return message
}

export async function sendProductUpdateEmail(
    client: EmailClient,
    options: ProductUpdateEmailOptions
) {
    const poller = await client.beginSend(buildProductUpdateEmail(options))
    return await poller.pollUntilDone()
}
