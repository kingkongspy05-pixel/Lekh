/* Lekh — document templates. Add your own: copy one object and edit the HTML. */
window.LEKH_TEMPLATES = [
  {
    id: 'blank', name: 'Blank document', title: 'Untitled document',
    html: '<p><br></p>'
  },
  {
    id: 'resume', name: 'Resume', title: 'Resume',
    page: { margins: { t: 0.7, r: 0.75, b: 0.7, l: 0.75 } },
    html: `
<p class="title" style="text-align:center">Your Name</p>
<p style="text-align:center"><span style="color:#5b6472">City, State · +91 00000 00000 · you@email.com · linkedin.com/in/you</span></p>
<hr>
<h2>Summary</h2>
<p>Two or three lines on who you are, what you are good at, and the kind of role you want next.</p>
<h2>Experience</h2>
<p><b>Job Title</b> — Organisation, City<span style="float:right;color:#5b6472">Mon YYYY – Present</span></p>
<ul><li>Achievement with a number: what you did and the result.</li><li>Another achievement that shows scope or ownership.</li><li>A third point that matches the job you are applying for.</li></ul>
<p><b>Job Title</b> — Organisation, City<span style="float:right;color:#5b6472">Mon YYYY – Mon YYYY</span></p>
<ul><li>Achievement with a number.</li><li>Another achievement.</li></ul>
<h2>Education</h2>
<p><b>Degree, Subject</b> — Institution<span style="float:right;color:#5b6472">YYYY</span></p>
<h2>Skills</h2>
<p><b>Technical:</b> Skill, Skill, Skill<br><b>Languages:</b> English, Hindi</p>
<h2>Projects</h2>
<p><b>Project name</b> — one line on what it is and what it achieved.</p>`
  },
  {
    id: 'cover', name: 'Cover letter', title: 'Cover letter',
    html: `
<p><b>Your Name</b><br>Address line<br>City, PIN<br>you@email.com · +91 00000 00000</p>
<p>DD Month YYYY</p>
<p>Hiring Manager<br>Company Name<br>Address<br>City, PIN</p>
<p>Dear Hiring Manager,</p>
<p>I am writing to apply for the <b>[Role]</b> position at <b>[Company]</b>. In one or two sentences, say why this role and why you.</p>
<p>In my current role at [Organisation], I [specific achievement with a number]. This is directly relevant because [link to their needs].</p>
<p>I would welcome the chance to discuss how I can contribute to [Company]. Thank you for your time and consideration.</p>
<p>Yours sincerely,</p>
<p><br></p>
<p>Your Name</p>`
  },
  {
    id: 'letter', name: 'Formal letter', title: 'Letter',
    html: `
<p style="text-align:right">Your Name<br>Address<br>City, PIN<br>DD Month YYYY</p>
<p>To,<br>The [Designation],<br>[Organisation],<br>[Address]</p>
<p><b>Subject: [Brief subject of the letter]</b></p>
<p>Respected Sir/Madam,</p>
<p>State the purpose of the letter clearly in the first paragraph.</p>
<p>Give the details, background or request in the second paragraph.</p>
<p>Close with what you expect next, and thank the reader.</p>
<p>Yours faithfully,</p>
<p><br></p>
<p>(Your Name)<br>[Contact details]</p>`
  },
  {
    id: 'om', name: 'Office memorandum', title: 'Office Memorandum',
    html: `
<p style="text-align:center"><b>No. [File No.]</b><br><b>Government of India</b><br><b>Ministry of [Name]</b><br><b>Department of [Name]</b></p>
<p style="text-align:right">[Building], New Delhi<br>Dated: DD Month, YYYY</p>
<p style="text-align:center"><b><u>OFFICE MEMORANDUM</u></b></p>
<p><b>Subject: [Subject] – regarding.</b></p>
<p style="text-align:justify">The undersigned is directed to refer to [reference] and to state that [content].</p>
<p style="text-align:justify">2.&nbsp;&nbsp;[Second paragraph].</p>
<p style="text-align:justify">3.&nbsp;&nbsp;This issues with the approval of the competent authority.</p>
<p style="text-align:right"><br>([Name])<br>[Designation]<br>Tel: [Number]</p>
<p>To<br>[Distribution list]</p>`
  },
  {
    id: 'meeting', name: 'Meeting notes', title: 'Meeting notes',
    html: `
<p class="title">Meeting notes</p>
<p class="subtitle">DD Month YYYY · Topic</p>
<table><tbody><tr><th>Attendees</th><td>Name, Name, Name</td></tr><tr><th>Facilitator</th><td>Name</td></tr><tr><th>Location</th><td>Room / link</td></tr></tbody></table>
<h2>Agenda</h2>
<ol><li>Item one</li><li>Item two</li><li>Item three</li></ol>
<h2>Discussion</h2>
<p>Key points raised and the reasoning behind decisions.</p>
<h2>Decisions</h2>
<ul><li>Decision one</li></ul>
<h2>Action items</h2>
<ul class="checklist"><li data-checked="false">Owner — task — due date</li><li data-checked="false">Owner — task — due date</li></ul>`
  },
  {
    id: 'report', name: 'Report', title: 'Report',
    footer: 'Page {page} of {pages}',
    html: `
<p class="title">Report title</p>
<p class="subtitle">Prepared by Your Name · DD Month YYYY</p>
<div class="toc" contenteditable="false"></div>
<h1>Executive summary</h1>
<p>Summarise the findings and recommendations in one paragraph a busy reader can act on.</p>
<h1>Background</h1>
<p>Explain the context and the question this report answers.</p>
<h2>Scope</h2>
<p>What is and isn't covered.</p>
<h1>Findings</h1>
<h2>Finding one</h2>
<p>Evidence and analysis.</p>
<h2>Finding two</h2>
<p>Evidence and analysis.</p>
<h1>Recommendations</h1>
<ol><li>Recommendation, owner and timeline.</li><li>Recommendation, owner and timeline.</li></ol>
<h1>Appendix</h1>
<p>Supporting data.</p>`
  },
  {
    id: 'essay', name: 'Essay / article', title: 'Essay',
    html: `
<p class="title">Essay title</p>
<p class="subtitle">A one-line hook that tells the reader why this matters</p>
<p>Opening paragraph: set up the question or tension.</p>
<h2>First idea</h2>
<p>Develop the argument with evidence and examples.</p>
<h2>Second idea</h2>
<p>Develop the argument further, or address the counter-argument.</p>
<h2>Conclusion</h2>
<p>Bring it together and leave the reader with one clear takeaway.</p>`
  },
  {
    id: 'manuscript', name: 'Manuscript chapter', title: 'Chapter 1',
    header: '{title}', footer: '{page}',
    html: `
<p style="text-align:center;line-height:2.4"><span style="font-family:'Times New Roman', Times, serif;font-size:12pt"><b>CHAPTER ONE</b></span></p>
<p style="text-align:center;line-height:2.4"><span style="font-family:'Times New Roman', Times, serif;font-size:12pt">Chapter Title</span></p>
<p style="line-height:2.4;text-indent:0.5in"><span style="font-family:'Times New Roman', Times, serif;font-size:12pt">Start your chapter here. Standard manuscript format uses 12 pt Times New Roman, double spacing and a half-inch first-line indent.</span></p>
<p style="line-height:2.4;text-indent:0.5in"><span style="font-family:'Times New Roman', Times, serif;font-size:12pt">Keep writing…</span></p>
<p style="text-align:center;line-height:2.4"><span style="font-family:'Times New Roman', Times, serif;font-size:12pt">#</span></p>`
  }
];
