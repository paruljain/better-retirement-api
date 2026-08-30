const assert = require('node:assert/strict')
const test = require('node:test')
const {
    buildProductUpdateEmail,
    renderMessageMarkdown
} = require('../dist/src/lib/productUpdateEmail')

test('renderMessageMarkdown renders basic formatting and escapes unsafe HTML', () => {
    const html = renderMessageMarkdown('# Update\n\n- **Improved** reports\n- <script>alert(1)</script>')

    assert.match(html, /<h1/)
    assert.match(html, /<strong>Improved<\/strong>/)
    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /&lt;script&gt;/)
})

test('buildProductUpdateEmail creates private single-recipient mail with unsubscribe headers', () => {
    process.env.EMAIL_UNSUBSCRIBE_SECRET = 'test-secret-that-is-not-used-in-production'

    const message = buildProductUpdateEmail({
        recipient: 'USER@EXAMPLE.COM',
        subject: 'A product update',
        markdown: 'We improved the reports.',
        senderAddress: 'no-reply@better-retirement.com',
        replyToAddress: 'support@better-retirement.com',
        publicApiBaseUrl: 'https://api.example.com/',
        postalAddress: '123 Main Street, Example, NY 10001'
    })

    assert.equal(message.recipients.to.length, 1)
    assert.equal(message.recipients.to[0].address, 'user@example.com')
    assert.equal(message.replyTo[0].address, 'support@better-retirement.com')
    assert.match(message.headers['List-Unsubscribe'], /^<https:\/\/api\.example\.com\/api\/email\/unsubscribe\?token=/)
    assert.equal(message.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
    assert.match(message.content.html, /Unsubscribe from product updates/)
    assert.match(message.content.plainText, /123 Main Street/)
})

test('buildProductUpdateEmail supports tester emails without a postal address', () => {
    process.env.EMAIL_UNSUBSCRIBE_SECRET = 'test-secret-that-is-not-used-in-production'

    const message = buildProductUpdateEmail({
        recipient: 'tester@example.com',
        subject: 'A beta update',
        markdown: 'Thanks for testing Better Retirement.',
        senderAddress: 'no-reply@better-retirement.com',
        publicApiBaseUrl: 'https://api.example.com'
    })

    assert.match(message.content.plainText, /Better Retirement\nUnsubscribe:/)
    assert.match(message.content.html, /<div>Better Retirement<\/div>/)
    assert.doesNotMatch(message.content.html, /Better Retirement · <\/div>/)
})
