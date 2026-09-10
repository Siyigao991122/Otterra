import { Resend } from "resend"

const FROM_ADDRESS = process.env.RESEND_FROM_EMAIL || "Otterra <onboarding@resend.dev>"

export type SendInviteEmailResult = { ok: true } | { ok: false; error: string }

function accessUrl(): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") || "https://otterra.ai"
  return `${base}/access`
}

function inviteEmailHtml(code: string): string {
  const url = accessUrl()
  return `<!doctype html>
<html>
  <body style="margin:0;padding:40px 20px;background:#f4f0e8;font-family:Georgia,'Times New Roman',serif;color:#30271f;">
    <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#fbf8f2;border:1px solid #d8cdbf;border-radius:24px;padding:40px;">
      <tr><td>
        <p style="margin:0 0 24px;font-size:22px;letter-spacing:-0.02em;">Otterra<span style="color:#9a795d;">.</span></p>
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.15em;text-transform:uppercase;color:#8a6d52;">You're in</p>
        <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2;">Your invite to Otterra</h1>
        <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#6a5c50;font-family:Arial,Helvetica,sans-serif;">
          Use the code below to unlock the floor plan studio. It works once, for you only.
        </p>
        <div style="margin:0 0 28px;padding:20px;background:#ebe4d8;border-radius:16px;text-align:center;">
          <span style="font-family:'SFMono-Regular',Consolas,monospace;font-size:24px;letter-spacing:0.15em;color:#30271f;">${code}</span>
        </div>
        <a href="${url}" style="display:inline-block;padding:14px 28px;background:#3a3028;color:#f4eee6;border-radius:999px;text-decoration:none;font-size:14px;font-family:Arial,Helvetica,sans-serif;">Enter code →</a>
        <p style="margin:28px 0 0;font-size:12px;color:#8a7a6b;font-family:Arial,Helvetica,sans-serif;">${url}</p>
      </td></tr>
    </table>
  </body>
</html>`
}

/** Best-effort — caller decides how to surface a failure (invite codes are still created either way). */
export async function sendInviteEmail(to: string, code: string): Promise<SendInviteEmailResult> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY is not configured." }
  }

  try {
    const resend = new Resend(apiKey)
    const { error } = await resend.emails.send({
      from: FROM_ADDRESS,
      to,
      subject: "Your Otterra invite code",
      html: inviteEmailHtml(code),
    })
    if (error) {
      return { ok: false, error: error.message }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to send email." }
  }
}
