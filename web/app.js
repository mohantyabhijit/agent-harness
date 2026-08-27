const esc = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const days = date => new Intl.DateTimeFormat('en', { month:'short', day:'numeric' }).format(new Date(date));
async function load() {
  const data = await fetch('/api/demo').then(response => response.json());
  const readiness = [data.repository.hasContributing,data.repository.hasCi,data.repository.hasLicense,data.repository.externalReview].filter(Boolean).length;
  document.querySelector('#repo').textContent = data.repository.fullName;
  document.querySelector('#score').textContent = `${readiness}/4 signals`;
  document.querySelector('#merge-count').textContent = `${data.mergedPullRequests.length} this week`;
  document.querySelector('#merges').innerHTML = data.mergedPullRequests.map(merge => `<div class="merge"><a href="${esc(merge.url)}" target="_blank" rel="noreferrer">#${merge.number} · ${esc(merge.title)}</a><time>${days(merge.mergedAt)} · merged</time></div>`).join('');
  document.querySelector('#candidates').innerHTML = data.candidateIssues.map((issue, index) => `<article class="card"><div class="card-top"><div><h3>${esc(issue.title)}</h3><p>${index ? 'Broader surface area and unclear acceptance criteria suggest a milestone-based campaign.' : 'A focused, test-backed contribution shaped by the repository’s recent dependency-maintenance pattern.'}</p></div><span class="tag">${index ? 'Long-term' : 'Easy win'}</span></div><div class="card-footer"><span>${index ? '12+ hours · needs discovery' : '4 hours · scoped'}</span><span>${index ? 'Explore →' : 'Start →'}</span></div></article>`).join('');
}
load().catch(() => { document.querySelector('#repo').textContent = 'Evidence unavailable'; });
document.querySelector('#refresh').addEventListener('click', () => load());
document.querySelector('#start').addEventListener('click', () => document.querySelector('#candidates').scrollIntoView({ behavior:'smooth', block:'center' }));
