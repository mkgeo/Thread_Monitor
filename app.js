// State Elements
let threads = [];
let activeThreadId = null;
let currentTargetLang = 'en'; // 'en', 'zh', 'none'

// DOM Elements
const urlInput = document.getElementById('url-input');
const addBtn = document.getElementById('add-btn');
const threadsList = document.getElementById('threads-list');
const tabContainer = document.getElementById('tab-container');
const contentArea = document.getElementById('content-area');
const langSelect = document.getElementById('lang-select');
const refreshBtn = document.getElementById('refresh-btn');

// Event Listeners
addBtn.addEventListener('click', handleAddThread);
urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleAddThread();
});

langSelect.addEventListener('change', (e) => {
    currentTargetLang = e.target.value;
    renderContent();
});

refreshBtn.addEventListener('click', () => {
    if (activeThreadId) {
        const thread = threads.find(t => t.id === activeThreadId);
        if (thread) fetchThreadData(thread.id, thread.url, true);
    }
});

async function handleAddThread() {
    const url = urlInput.value.trim();
    if (!url) return;

    const newThread = {
        id: Date.now().toString(),
        url: url,
        title: `Loading thread...`,
        status: 'loading', 
        data: null
    };

    threads.push(newThread);
    urlInput.value = '';
    
    activeThreadId = newThread.id;
    
    renderSidebar();
    renderTabs();
    renderContent();

    await fetchThreadData(newThread.id, url, false);
}

async function fetchThreadData(threadId, url, isRefresh = false) {
    const threadIndex = threads.findIndex(t => t.id === threadId);
    if (threadIndex === -1) return;

    if (isRefresh) {
        threads[threadIndex].status = 'loading'; // visual indicator
        renderTabs();
    }

    let htmlString = "";

    try {
        const directResponse = await fetch(url);
        htmlString = await directResponse.text();
    } catch (directError) {
        try {
            const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
            const response = await fetch(proxyUrl);
            const json = await response.json();
            htmlString = json.contents;
        } catch (proxyError) {
            threads[threadIndex].status = 'error';
            renderContent();
            renderTabs();
            return;
        }
    }

    if (!htmlString) {
        threads[threadIndex].status = 'error';
        renderContent();
        renderTabs();
        return;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');

    const pageTitle = doc.querySelector('title') ? doc.querySelector('title').innerText : '';
    if (pageTitle.includes("アクセスエラー") || pageTitle.includes("Access denied")) {
        threads[threadIndex].status = 'error';
        renderContent();
        renderTabs();
        return;
    }

    let title = pageTitle || url;
    const articleNodes = doc.querySelectorAll('.article, .res_body, article, .message, [itemprop="text"]');

    if (articleNodes.length === 0) {
        threads[threadIndex].status = 'error';
        renderContent();
        renderTabs();
        return;
    }

    let existingPosts = threads[threadIndex].data ? threads[threadIndex].data.posts : [];
    const posts = [];

    // Parse ALL posts without a strict limit
    for (let i = 0; i < articleNodes.length; i++) {
        const node = articleNodes[i];
        let jpText = node.innerText.trim();
        
        // Clean up common forum artifacts
        jpText = jpText.replace(/>>\d+/g, ''); // Remove reply anchors like >>914
        jpText = jpText.replace(/最新レス/g, ''); // Remove latest response tag
        // Remove "? Good! ? Bad" polls along with any emojis or numbers attached to them
        jpText = jpText.replace(/(?:[\uD800-\uDBFF][\uDC00-\uDFFF]|\?|👍|👎)?\s*(Good!|Bad)\s*\d*/gi, '');
        // Remove NO.xxxxx 2026/03/17 01:50 header line that sneaks into post bodies
        jpText = jpText.replace(/NO\.\d+\s+\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}/gi, '');
        
        jpText = jpText.trim(); 
        if (!jpText) continue;

        let dateText = "Unknown Date";
        let authorText = "Anonymous";
        
        const parent = node.closest('.res, .post, tr, .thread-post') || node.parentElement;
        if (parent) {
            const dateMatch = parent.innerText.match(/\d{4}\/\d{2}\/\d{2}\s\d{2}:\d{2}/);
            if (dateMatch) dateText = dateMatch[0];
            const noMatch = parent.innerText.match(/#\d+|NO\.\d+/i);
            if (noMatch) authorText = noMatch[0];
        }

        let en = "", zh = "";
        
        // If we already translated this text, preserve it to prevent re-translating!
        const existing = existingPosts.find(p => p.jp === jpText);
        if (existing) {
            en = existing.en;
            zh = existing.zh;
        }

        posts.push({ id: posts.length + 1, author: authorText, date: dateText, jp: jpText, en, zh });
    }

    threads[threadIndex].status = 'ready';
    threads[threadIndex].title = title.substring(0, 30) + "...";
    threads[threadIndex].data = { title, posts };
    
    if (activeThreadId === threadId) {
        renderSidebar();
        renderTabs();
        renderContent();
    }
}

// ---------------------------------------------
// Translation Lazy-loading Logic
// ---------------------------------------------
let isTranslating = false; // Simple mutex to prevent Google throttling via parallel bursts

const translationObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const el = entry.target;
            const threadId = el.getAttribute('data-thread-id');
            const postId = parseInt(el.getAttribute('data-post-id'));
            
            translateSinglePost(threadId, postId, currentTargetLang);
            observer.unobserve(el); 
        }
    });
}, { root: contentArea, rootMargin: '200px' });

async function translateSinglePost(threadId, postId, targetLang) {
    if (targetLang === 'none') return;
    const thread = threads.find(t => t.id === threadId);
    if (!thread || !thread.data) return;
    
    const post = thread.data.posts[postId - 1];
    if (!post || !post.jp || post[targetLang]) return; 

    // Wait until channel is free to prevent HTTP 429
    while(isTranslating) {
        await new Promise(r => setTimeout(r, 100));
    }
    isTranslating = true;

    try {
        const translateUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ja&tl=${targetLang}&dt=t&q=${encodeURIComponent(post.jp)}`;
        const res = await fetch(translateUrl);
        const json = await res.json();
        
        let translated = "";
        if (json && json[0]) {
            json[0].forEach(segment => {
                if (segment[0]) translated += segment[0];
            });
        }
        post[targetLang] = translated;

        // Update the specific DOM element safely
        if (activeThreadId === threadId && currentTargetLang === targetLang) {
            const transEl = document.getElementById(`trans-${threadId}-${post.id}`);
            if (transEl) transEl.innerHTML = translated;
        }
    } catch (e) {
        post[targetLang] = "(Translation Failed or Rate Limited)";
        if (activeThreadId === threadId && currentTargetLang === targetLang) {
            const transEl = document.getElementById(`trans-${threadId}-${post.id}`);
            if (transEl) transEl.innerHTML = post[targetLang];
        }
    }

    await new Promise(r => setTimeout(r, 200)); // Respectful delay
    isTranslating = false;
}

// ---------------------------------------------
// UI Rendering
// ---------------------------------------------
function removeThread(threadId, event) {
    if (event) event.stopPropagation();
    threads = threads.filter(t => t.id !== threadId);
    if (activeThreadId === threadId) {
        activeThreadId = threads.length > 0 ? threads[0].id : null;
    }
    renderSidebar();
    renderTabs();
    renderContent();
}

function switchTab(threadId) {
    activeThreadId = threadId;
    renderSidebar();
    renderTabs();
    renderContent();
}

function renderSidebar() {
    threadsList.innerHTML = '';
    threads.forEach(thread => {
        const div = document.createElement('div');
        div.className = `thread-item ${thread.id === activeThreadId ? 'active' : ''}`;
        div.onclick = () => switchTab(thread.id);
        div.innerHTML = `
            <div>
                <strong>${thread.title}</strong>
                <span class="thread-url">${thread.url}</span>
            </div>
            <span class="close-btn" onclick="removeThread('${thread.id}', event)" title="Close Thread">×</span>
        `;
        threadsList.appendChild(div);
    });
}

function renderTabs() {
    tabContainer.innerHTML = '';
    threads.forEach(thread => {
        const div = document.createElement('div');
        div.className = `tab ${thread.id === activeThreadId ? 'active' : ''}`;
        div.onclick = () => switchTab(thread.id);
        
        const statusIcon = thread.status === 'loading' ? '⌛ ' : '';
        div.innerHTML = `
            ${statusIcon}${thread.title}
            <span class="close-btn" onclick="removeThread('${thread.id}', event)" style="margin-left: 5px;" title="Close Thread">×</span>
        `;
        tabContainer.appendChild(div);
    });
}

function renderContent() {
    translationObserver.disconnect(); // Reset observers
    refreshBtn.style.display = activeThreadId ? 'block' : 'none';

    if (!activeThreadId) {
        contentArea.innerHTML = `
            <div class="empty-state">
                <h3>No Thread Selected</h3>
                <p>Add a forum thread URL from the left panel to start reading.</p>
            </div>
        `;
        return;
    }

    const activeThread = threads.find(t => t.id === activeThreadId);

    if (activeThread.status === 'loading' && !activeThread.data) {
        contentArea.innerHTML = `
            <div class="loader">
                <div class="spinner"></div>
                <p>Fetching data from the live forum link...</p>
            </div>
        `;
        return;
    }

    if (activeThread.status === 'error') {
        contentArea.innerHTML = `
            <div class="empty-state" style="color: #ef4444;">
                <h3 style="margin-bottom: 10px;">Error Loading Thread</h3>
                <p>Could not fetch data directly from this URL.</p>
                <div style="background: rgba(239, 68, 68, 0.1); padding: 15px; border-radius: 8px; border: 1px solid rgba(239, 68, 68, 0.3); margin-top: 20px; font-size: 0.95rem; text-align: left; max-width: 500px;">
                    <p style="color: #fca5a5; font-weight: 600; margin-bottom: 8px;">Why did this happen?</p>
                    <p style="color: #f87171; margin-bottom: 12px;">Sites like Bakusai actively block automatic proxy servers using Cloudflare to prevent scraping ("アクセスエラー").</p>
                    <p style="color: #fca5a5; font-weight: 600; margin-bottom: 8px;">How to fix it right now:</p>
                    <ol style="color: #f87171; margin-left: 20px; display: flex; flex-direction: column; gap: 8px;">
                        <li>Install a free browser extension like <strong>"Allow CORS: Access-Control-Allow-Origin"</strong></li>
                        <li>Turn the extension <strong>ON</strong>.</li>
                        <li>Add the URL again! The app will fetch it seamlessly directly through your browser.</li>
                    </ol>
                </div>
            </div>
        `;
        return;
    }

    const data = activeThread.data;
    let html = `<h2>${data.title}</h2><br/>`;

    [...data.posts].reverse().forEach(post => {
        let transHtml = "";
        if (currentTargetLang !== 'none') {
            const currentTrans = post[currentTargetLang];
            transHtml = `<div class="content-translation" id="trans-${activeThread.id}-${post.id}">${currentTrans ? currentTrans : '<span style="opacity: 0.5;">Translating...</span>'}</div>`;
        }

        html += `
            <div class="post" data-thread-id="${activeThread.id}" data-post-id="${post.id}">
                <div class="post-header">
                    <span class="post-author">${post.author}</span>
                    <span class="post-date">${post.date}</span>
                </div>
                <div class="post-content">
                    <div class="content-jp">${post.jp}</div>
                    ${transHtml}
                </div>
            </div>
        `;
    });

    contentArea.innerHTML = html;

    // Observe posts missing translations
    if (currentTargetLang !== 'none') {
        document.querySelectorAll('.post').forEach(el => {
            const postId = el.getAttribute('data-post-id');
            const post = data.posts[postId - 1];
            if (post && !post[currentTargetLang]) {
                translationObserver.observe(el);
            }
        });
    }
}
