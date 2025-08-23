import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

export async function sendCallSummary(participant, summary, callDetails) {
  const { roomId, callDate } = callDetails;
  
  const isBusinessCall = summary.toLowerCase().includes('decision') || 
                         summary.toLowerCase().includes('meeting') || 
                         summary.toLowerCase().includes('action item') ||
                         summary.toLowerCase().includes('professional') ||
                         summary.toLowerCase().includes('business') ||
                         summary.toLowerCase().includes('project') ||
                         summary.toLowerCase().includes('client');
  
  const greeting = isBusinessCall ? `Dear ${participant.user}` : `Hi ${participant.user}`;
  const intro = isBusinessCall ? 
    "Here's a summary of your recent call:" : 
    "Here's what you and your contact talked about:";
  
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          line-height: 1.6; 
          color: #333; 
          max-width: 600px;
          margin: 0 auto;
          padding: 20px;
        }
        .header { 
          background: ${isBusinessCall ? '#2563eb' : '#22c55e'}; 
          color: white; 
          padding: 15px; 
          text-align: center;
          border-radius: 8px;
          margin-bottom: 20px;
        }
        .summary { 
          background: #f9f9f9; 
          padding: 20px; 
          border-radius: 8px;
          border-left: 4px solid ${isBusinessCall ? '#2563eb' : '#22c55e'};
          line-height: 1.7;
        }
        .footer {
          margin-top: 20px;
          color: #666;
          font-size: 14px;
          text-align: center;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h3>${isBusinessCall ? 'Call Summary' : 'Call Recap'}</h3>
      </div>
      
      <p>${greeting},</p>
      <p>${intro}</p>
      
      <div class="summary">
        ${summary}
      </div>
      
      <div class="footer">
        <p>${new Date(callDate).toLocaleDateString()}</p>
        <p><em>Auto-generated summary</em></p>
      </div>
    </body>
    </html>
  `;

  const subject = isBusinessCall ? 
    `Call Summary - ${new Date(callDate).toLocaleDateString()}` :
    `Your call recap - ${new Date(callDate).toLocaleDateString()}`;

  try {
    await transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME || 'Video Calling App'}" <${process.env.EMAIL_USER}>`,
      to: participant.email,
      subject: subject,
      html: emailHtml
    });
    
    console.log(`📧 Summary sent to ${participant.user} (${participant.email})`);
    return true;
    
  } catch (error) {
    console.error(`❌ Failed to send email to ${participant.user}:`, error.message);
    return false;
  }
}
