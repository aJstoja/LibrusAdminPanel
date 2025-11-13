// ==UserScript==
// @name         Librus Synergia AdminPanel
// @version      2.4.1
// @description  Zaawansowany edytor ocen, który precyzyjnie modyfikuje istniejące elementy HTML bez dodawania atrybutów data-, z edycją kolorów dla każdej części poprawki.
// @author       Jan Działak (poprawki: AI)
// @match        *://synergia.librus.pl/przegladaj_oceny/uczen*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    //--- CONFIG & STATE ---
    const SAVE_PREFIX = 'librus_grades_';
    const DEFAULT_SAVE = 'Oryginalne oceny';
    const CORRECTION_SEPARATOR = ' {->} ';
    let isInitialized = false;
    let originalGradesData = [];
    let currentGrades = [];
    let subjectList = [];
    let originalSubjectRows = new Map();
    let gradeElements = new Map(); // Klucz: grade.id, Wartość: Element <span>
    let currentSave = DEFAULT_SAVE;

    //--- STYLES ---
    GM_addStyle(`
        .lgs-panel, #lgs-loading-msg { position: fixed; z-index: 99999; background: #fff; border-radius: 8px; padding: 12px; font-family: Arial, sans-serif; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
        .lgs-panel { border: 2px solid; max-height: 80vh; overflow-y: auto; display: none; }
        #lgs-loading-msg { top: 50%; left: 50%; transform: translate(-50%, -50%); border: 2px solid #0066cc; display: none;}
        #librus-grade-editor { top: 10px; right: 10px; max-width: 420px; border-color: #0066cc; }
        #librus-saves-manager { top: 60px; right: 450px; max-width: 300px; border-color: #4CAF50; }
        .lgs-panel-header { cursor: move; padding-bottom: 10px; border-bottom: 1px solid #ddd; margin-bottom: 10px; user-select: none; }
        .lgs-panel-header h3 { margin: 0; display: inline-block; }
        .lgs-grade-item, .lgs-subject-manager, .lgs-metadata-editor { padding: 6px 0; border-bottom: 1px solid #eee; }
        .lgs-grade-row, .lgs-subject-row, .lgs-metadata-row { display: flex; gap: 6px; align-items: center; }
        .lgs-metadata-editor label { font-weight: bold; min-width: 70px; }
        .lgs-metadata-editor input { flex: 1; }
        .lgs-metadata-tabs { display: flex; gap: 5px; margin-bottom: 10px; flex-wrap: wrap; }
        .lgs-tab { background: #eee; padding: 5px 10px; border-radius: 5px 5px 0 0; cursor: pointer; display: flex; align-items: center; gap: 5px; }
        .lgs-tab.active { background: #0066cc; color: white; }
        .lgs-input { padding: 4px; border: 1px solid #ccc; border-radius: 4px; }
        .lgs-color-input { min-width: 28px; height: 28px; padding: 2px; border: 1px solid #ccc; cursor: pointer; }
        .lgs-grade-input { width: 90px; }
        .lgs-subject-select { flex: 1; min-width: 120px; }
        .lgs-btn { padding: 4px 8px; cursor: pointer; border-radius: 4px; border: none; font-weight: bold; }
        .lgs-btn-save, .lgs-btn-meta-save { background: #4CAF50; color: white; }
        .lgs-btn-del, .lgs-btn-meta-back { background: #f44336; color: white; }
        .lgs-btn-add, .lgs-btn-manager, .lgs-btn-edit { background: #2196F3; color: white; }
        .lgs-btn-add { margin-top: 8px; }
        .lgs-hidden { display: none !important; }
        .lgs-added-grade-container { display: inline-block; margin: 0 2px; }
        #lgs-no-grades-msg { color: #999; font-style: italic; margin: 10px; }
    `);

    //--- PARSING & DATA EXTRACTION ---
    function parseGradeTitle(title) {
        const data = { weight: 1, comment: '', category: 'Inna', date: '', teacher: '', adder: '', countsToAverage: true };
        if (!title) return data;
        const match = (regex) => (title.match(regex) || [])[1]?.trim();
        data.category = match(/Kategoria: (.*?)(?:<br|$)/) || data.category;
        data.date = match(/Data: (.*?)(?:<br|$)/) || data.date;
        data.teacher = match(/Nauczyciel: (.*?)(?:<br|$)/) || data.teacher;
        data.adder = match(/Dodał: (.*?)(?:<br|$)/) || data.adder || data.teacher;
        data.weight = parseFloat(match(/Waga: ([\d.]+)/)) || data.weight;
        data.comment = match(/Komentarz: (.*)/s)?.replace(/<br\s*\/?>/gi, ' ') || '';
        if (title.includes('Licz do średniej: nie')) data.countsToAverage = false;
        return data;
    }

    function buildTitle(gradePart) {
        let title = `Kategoria: ${gradePart.category}<br>Data: ${gradePart.date}<br>Nauczyciel: ${gradePart.teacher}<br>`;
        if (gradePart.countsToAverage) title += `Licz do średniej: tak<br>Waga: ${gradePart.weight}<br>`;
        title += `Dodał: ${gradePart.adder}<br><br>Komentarz: ${gradePart.comment}`;
        return title;
    }

    function extractGradesAndSubjects() {
        originalSubjectRows.clear();
        gradeElements.clear();
        const grades = [];
        const subjects = new Set();
        const table = document.querySelector('h3.center + .right + table.decorated.stretch');
        if (!table) return;

        let gradeIdCounter = 0;
        table.querySelectorAll('tbody > tr').forEach(row => {
            if (row.getAttribute('name') === 'przedmioty_all') return;
            const subjectCell = row.cells[1];
            if (!subjectCell) return;
            const subjectName = subjectCell.textContent.trim();
            if (!subjectName || subjectName === 'Zachowanie' || row.cells.length < 9) return;

            subjects.add(subjectName);
            originalSubjectRows.set(subjectName, { element: row, originalAvg: row.cells[3].innerHTML });
            const gradesCell = row.cells[2];

            if (gradesCell) {
                gradesCell.childNodes.forEach(node => {
                    if (node.nodeType !== 1) return;

                    let gradeChain = { subject: subjectName, id: gradeIdCounter++, parts: [] };

                    const processLinks = (links) => {
                        links.forEach(link => {
                            const box = link.closest('.grade-box');
                            gradeChain.parts.push({ grade: link.textContent.trim(), ...parseGradeTitle(link.title), color: box.style.backgroundColor ? rgbToHex(box.style.backgroundColor) : '#cccccc', href: link.getAttribute('href') });
                        });
                        gradeElements.set(gradeChain.id, node);
                        grades.push(gradeChain);
                    };

                    if (node.nodeName === 'SPAN') {
                        processLinks(Array.from(node.querySelectorAll('a.ocena')));
                    }
                });
            }
        });
        originalGradesData = JSON.parse(JSON.stringify(grades));
        currentGrades = JSON.parse(JSON.stringify(grades));
        subjectList = Array.from(subjects).sort();
    }

    function rgbToHex(rgb) {
        if (!rgb || !rgb.startsWith('rgb')) return rgb;
        return "#" + rgb.match(/\d+/g).map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
    }

    //--- PAGE VIEW UPDATE ---
    function createSubjectRow(subjectName, tbody) {
        const tr = document.createElement('tr');
        tr.className = 'lgs-added-row line0';
        tr.dataset.subject = subjectName;
        tr.innerHTML = `
            <td class='center micro screen-only'></td>
            <td>${subjectName}</td><td></td><td class="center">&nbsp;</td>
            <td class="center">-</td><td></td><td class="center">&nbsp;</td>
            <td class="center">-</td><td class="center">&nbsp;</td><td class="center">-</td>`;
        tbody.appendChild(tr);
        return tr;
    }

    function gradeToNumeric(grade) {
        if (!grade) return null;
        let mainGrade = parseFloat(grade);
        if (isNaN(mainGrade)) return null;
        if (grade.includes('+')) mainGrade += 0.5;
        if (grade.includes('-')) mainGrade -= 0.25;
        return mainGrade;
    }

    function updatePageView() {
        document.querySelectorAll('.lgs-added-grade-container, .lgs-added-row').forEach(el => el.remove());
        gradeElements.forEach(el => el.classList.remove('lgs-hidden'));

        const gradesBySubject = currentGrades.reduce((acc, g) => ({ ...acc, [g.subject]: [...(acc[g.subject] || []), g] }), {});
        const table = document.querySelector('h3.center + .right + table.decorated.stretch');
        if (!table) return;
        const tbody = table.querySelector('tbody');
        const calculateAverages = document.getElementById('lgs-calc-avg')?.checked;

        const processedOriginals = new Set();
        currentGrades.forEach(g => {
            if (String(g.id).startsWith('new_')) { // Create new grade
                let row = originalSubjectRows.get(g.subject)?.element || tbody.querySelector(`tr[data-subject="${g.subject}"]`);
                if (!row) row = createSubjectRow(g.subject, tbody);
                const gradesCell = row.cells[2];
                if(gradesCell) {
                    const newContainer = document.createElement('span');
                    newContainer.className = 'lgs-added-grade-container';
                    const part = g.parts[0];
                    newContainer.innerHTML = `<span class="grade-box" style="background-color: ${part.color};"><a class="ocena" title="${buildTitle(part)}">${part.grade}</a></span>`;
                    gradesCell.appendChild(newContainer);
                }
            } else { // Modify existing grade
                processedOriginals.add(g.id);
                const container = gradeElements.get(g.id);
                if (!container) return;

                container.classList.remove('lgs-hidden');
                let newHTML = '';
                if (g.parts.length > 1) {
                    newHTML = '[';
                    g.parts.forEach((part, index) => {
                        const isLast = index === g.parts.length - 1;
                        const href = part.href ? `href="${part.href}"` : 'href="javascript:void(0);"';
                        newHTML += `<span class="grade-box" style="background-color: ${isLast ? part.color : '#C0C0C0'};"><a class="ocena" ${href} title="${buildTitle(part)}">${part.grade}</a></span>`;
                    });
                    newHTML += ']';
                } else if (g.parts.length === 1) {
                    const part = g.parts[0];
                    const href = part.href ? `href="${part.href}"` : 'href="javascript:void(0);"';
                    container.style.backgroundColor = part.color;
                    newHTML = `<a class="ocena" ${href} title="${buildTitle(part)}">${part.grade}</a>`;
                }

                if (container.innerHTML !== newHTML) {
                    container.innerHTML = newHTML;
                }
            }
        });

        gradeElements.forEach((el, id) => {
            if (!processedOriginals.has(id)) el.classList.add('lgs-hidden');
        });

        subjectList.forEach(subjectName => {
             const rowData = originalSubjectRows.get(subjectName);
             if (rowData && rowData.element.cells[3]) {
                 const avgCell = rowData.element.cells[3];
                 if (calculateAverages) {
                    let sum = 0, weightSum = 0;
                    (gradesBySubject[subjectName] || []).forEach(g => {
                        const lastPart = g.parts[g.parts.length - 1];
                        if (lastPart && lastPart.countsToAverage) {
                            const gradeValue = gradeToNumeric(lastPart.grade);
                            if (gradeValue !== null) {
                                sum += gradeValue * lastPart.weight;
                                weightSum += lastPart.weight;
                            }
                        }
                    });
                    avgCell.innerHTML = weightSum > 0 ? (sum / weightSum).toFixed(2) : '-';
                 } else {
                     avgCell.innerHTML = rowData.originalAvg;
                 }
             }
        });
    }

    //--- GUI ---
    // Pozostałe funkcje GUI i logiki (bez zmian w tej aktualizacji)
    function createAdminPanelGui(){if(document.getElementById("librus-grade-editor"))return;const e=document.createElement("div");e.id="librus-grade-editor",e.className="lgs-panel",e.innerHTML=`
            <div class="lgs-panel-header"><h3>🔧 Edytor ocen</h3></div><div id="lgs-grades-list"></div>
            <button class="lgs-btn lgs-btn-add" id="lgs-add-grade">+ Dodaj ocenę</button>
            <div class="lgs-subject-manager"><h4>Zarządzaj przedmiotami</h4><div class="lgs-subject-row">
                <select id="lgs-subject-mgmt-list" class="lgs-input lgs-subject-select"></select>
                <button id="lgs-delete-subject" class="lgs-btn lgs-btn-del" title="Usuń wybrany przedmiot">🗑️</button>
                <button id="lgs-add-subject" class="lgs-btn lgs-btn-add" title="Dodaj nowy przedmiot">+</button>
            </div></div>
            <button class="lgs-btn lgs-btn-manager" id="lgs-open-saves">Zarządzaj zapisami (S)</button>
            <div style="margin-top:10px;font-size:0.85em;color:#666;">[A] Pokaż/ukryj edytor</div>`,document.body.appendChild(e),makeDraggable(e,e.querySelector(".lgs-panel-header")),e.querySelector("#lgs-add-grade").onclick=addGradeRow,e.querySelector("#lgs-open-saves").onclick=toggleSavesManagerVisibility,e.querySelector("#lgs-add-subject").onclick=addSubject,e.querySelector("#lgs-delete-subject").onclick=deleteSubject}
    function createSavesManagerGui(){if(document.getElementById("librus-saves-manager"))return;const e=document.createElement("div");e.id="librus-saves-manager",e.className="lgs-panel",e.innerHTML=`
            <div class="lgs-panel-header"><h3>🗂️ Menedżer Zapisów (<span id="lgs-save-name">${currentSave}</span>)</h3></div>
            <div><label>Nazwa: <input type="text" id="lgs-save-as" class="lgs-input" value="${currentSave}"></label>
              <button class="lgs-btn lgs-btn-save" id="lgs-save-btn">💾 Zapisz</button></div>
            <div style="margin-top: 5px;"><input type="checkbox" id="lgs-calc-avg"><label for="lgs-calc-avg"> Obliczaj średnie</label></div>
            <div class="lgs-save-list" id="lgs-saves-list"></div>`,document.body.appendChild(e),makeDraggable(e,e.querySelector(".lgs-panel-header")),e.querySelector("#lgs-save-btn").onclick=saveCurrentSet,document.getElementById("lgs-save-as").onkeypress=e=>"Enter"===e.key&&saveCurrentSet(),document.getElementById("lgs-calc-avg").onchange=updatePageView}
    function renderAllGui(){document.getElementById("librus-grade-editor")&&renderGradesListInGui(),document.getElementById("librus-saves-manager")&&renderSavesList(),renderSubjectMgmtList()}
    function renderGradesListInGui(){const e=document.getElementById("lgs-grades-list");if(!e)return;if(0===currentGrades.length)return void(e.innerHTML='<div id="lgs-no-grades-msg">Brak ocen.</div>');const t=subjectList.map(e=>`<option value="${e}">${e}</option>`).join("");e.innerHTML=currentGrades.map((e,a)=>{const s=e.parts.map(e=>e.grade).join(" {->} ");return`<div class="lgs-grade-item" data-grade-item-index="${a}"><div class="lgs-grade-row">
                <input class="lgs-input lgs-grade-input" value="${s}" data-index="${a}" data-field="grade" title="Ocena (format poprawek: 1 {->} 5)">
                <select class="lgs-input lgs-subject-select" data-index="${a}" data-field="subject">${t}</select>
                <button class="lgs-btn lgs-btn-edit" data-index="${a}" title="Edytuj szczegóły">⚙️</button>
                <button class="lgs-btn lgs-btn-del" data-index="${a}" title="Usuń">×</button>
            </div></div>`}).join(""),e.querySelectorAll("select.lgs-subject-select").forEach((e,t)=>{currentGrades[t]&&(e.value=currentGrades[t].subject)}),e.querySelectorAll("input, select").forEach(e=>e.oninput=t=>{const a=t.target.dataset,s=currentGrades[a.index];if(!s)return;"grade"===a.field?s.parts=t.target.value.split(" {->} ").map((e,t)=>{const a=s.parts[t]||{...parseGradeTitle(""),color:"#cccccc"};return a.grade=e.trim(),a}):s[a.field]=t.target.value,updatePageView()}),e.querySelectorAll(".lgs-btn-del").forEach(e=>e.onclick=t=>{currentGrades.splice(parseInt(t.target.dataset.index,10),1),renderAllGui(),updatePageView()}),e.querySelectorAll(".lgs-btn-edit").forEach(e=>e.onclick=t=>renderMetadataEditor(parseInt(t.target.dataset.index,10)))}
    function renderMetadataEditor(e){const t=currentGrades[e],a=document.querySelector(`[data-grade-item-index="${e}"]`);if(!t||!a)return;let s=0;const n=()=>{const e=t.parts[s];if(!e)return;let l=t.parts.map((e,t)=>`<div class="lgs-tab ${t===s?"active":""}" data-tab-index="${t}"><input type="color" class="lgs-color-input" value="${e.color}" data-part-index="${t}">Ocena ${t+1}</div>`).join("");a.innerHTML=`
            <div class="lgs-metadata-editor">
                <div class="lgs-metadata-tabs">${l}</div>
                <div class="lgs-metadata-row"><label>Kategoria:</label><input type="text" data-field="category" value="${e.category}"></div>
                <div class="lgs-metadata-row"><label>Data:</label><input type="text" data-field="date" value="${e.date}"></div>
                <div class="lgs-metadata-row"><label>Nauczyciel:</label><input type="text" data-field="teacher" value="${e.teacher}"></div>
                <div class="lgs-metadata-row"><label>Waga:</label><input type="number" data-field="weight" value="${e.weight}"></div>
                <div style="text-align: right; margin-top: 5px;">
                    <button class="lgs-btn lgs-btn-meta-back">⬅️ Powrót</button>
                    <button class="lgs-btn lgs-btn-meta-save">✅ Zapisz</button>
                </div>
            </div>`,a.querySelectorAll(".lgs-tab").forEach(e=>e.onclick=t=>{if("INPUT"===t.target.tagName)return;s=parseInt(e.dataset.tabIndex),n()}),a.querySelectorAll(".lgs-color-input").forEach(e=>e.oninput=a=>{t.parts[e.dataset.partIndex].color=a.target.value,updatePageView()}),a.querySelector(".lgs-btn-meta-back").onclick=renderAllGui,a.querySelector(".lgs-btn-meta-save").onclick=()=>{a.querySelectorAll("input[data-field]").forEach(a=>{const s=a.dataset.field;t.parts[n][s]="weight"===s?parseFloat(a.value):a.value}),renderAllGui(),updatePageView()}};n()}
    function renderSubjectMgmtList(){const e=document.getElementById("lgs-subject-mgmt-list");e&&(e.innerHTML=subjectList.map(e=>`<option value="${e}">${e}</option>`).join(""))}
    function addGradeRow(){const e=subjectList.length>0?subjectList[0]:"Nowy przedmiot";0===subjectList.length&&subjectList.push("Nowy przedmiot"),currentGrades.push({subject:e,id:"new_"+Date.now(),parts:[{grade:"5",weight:1,comment:"",color:"#87CEFA",category:"Inna",date:(new Date).toISOString().slice(0,10),teacher:"Nauczyciel",adder:"Nauczyciel",countsToAverage:!0}]}),renderAllGui(),updatePageView()}
    function addSubject(){const e=prompt("Podaj nazwę nowego przedmiotu:");e&&!subjectList.includes(e)?(subjectList.push(e),subjectList.sort(),renderAllGui(),updatePageView()):e&&alert("Taki przedmiot już istnieje!")}
    function deleteSubject(){const e=document.getElementById("lgs-subject-mgmt-list");!e||!e.value||confirm(`Czy na pewno usunąć przedmiot "${e.value}" i wszystkie jego oceny?`)&&(currentGrades=currentGrades.filter(t=>t.subject!==e.value),subjectList=subjectList.filter(t=>t!==e.value),renderAllGui(),updatePageView())}
    function makeDraggable(e,t){let a=0,n=0,s=0,l=0;t.onmousedown=r=>{r.preventDefault(),s=r.clientX,l=r.clientY,document.onmouseup=()=>{document.onmouseup=null,document.onmousemove=null},document.onmousemove=r=>{r.preventDefault(),a=s-r.clientX,n=l-r.clientY,s=r.clientX,l=r.clientY,e.style.top=`${e.offsetTop-n}px`,e.style.left=`${e.offsetLeft-a}px`}}}
    function listSaves(){const e=GM_getValue("librus_save_list",[]),t=[...new Set(e)];return t.length!==e.length&&GM_setValue("librus_save_list",t),[DEFAULT_SAVE,...t]}
    function renderSavesList(){const e=document.getElementById("lgs-saves-list");if(!e)return;e.innerHTML="<strong>Zapisane zestawy:</strong>"+listSaves().map(e=>`<div class="lgs-save-item ${e===currentSave?"active":""}" data-save="${e}"><span>${e}</span> ${"Oryginalne oceny"!==e?`<button class="lgs-btn lgs-btn-del" data-save="${e}" style="font-size:10px;padding:1px 4px;" title="Usuń">🗑️</button>`:""}</div>`).join(""),e.querySelectorAll(".lgs-save-item").forEach(e=>e.onclick=t=>{t.target.classList.contains("lgs-btn-del")||loadSave(e.dataset.save)}),e.querySelectorAll(".lgs-btn-del").forEach(e=>e.onclick=t=>{t.stopPropagation(),confirm(`Usunąć zestaw "${e.dataset.save}"?`)&&(deleteSave(e.dataset.save),currentSave===e.dataset.save&&loadSave(DEFAULT_SAVE),renderSavesList())})}
    function saveCurrentSet(){const e=document.getElementById("lgs-save-as").value.trim();if(!e)return alert("Podaj nazwę!");if("Oryginalne oceny"===e)return alert('Nie można nadpisać "Oryginalne oceny".');const t=GM_getValue("librus_save_list",[]);if(t.includes(e)&&currentSave!==e&&!confirm(`Zestaw "${e}" istnieje. Nadpisać?`))return;GM_setValue(SAVE_PREFIX+e,JSON.stringify(currentGrades)),t.includes(e)||GM_setValue("librus_save_list",[...t,e]),currentSave=e,document.getElementById("lgs-save-name")&&(document.getElementById("lgs-save-name").textContent=e),renderSavesList();const a=document.getElementById("lgs-save-btn");a.textContent="✅",setTimeout(()=>{a.textContent="💾 Zapisz"},2e3)}
    function loadSave(e){"Oryginalne oceny"===e?(currentGrades=JSON.parse(JSON.stringify(originalGradesData)),subjectList=Array.from(originalSubjectRows.keys()).sort()):(currentGrades=JSON.parse(GM_getValue(SAVE_PREFIX+e,"[]")),((e=new Set(originalSubjectRows.keys()))=>{currentGrades.forEach(t=>e.add(t.subject)),subjectList=Array.from(e).sort()})()),currentSave=e,GM_setValue("last_save",e),updatePageView(),renderAllGui();const t=document.getElementById("librus-saves-manager");t&&(document.getElementById("lgs-save-as").value=e,document.getElementById("lgs-save-name").textContent=e)}
    function deleteSave(e){"Oryginalne oceny"!==e&&(GM_deleteValue(SAVE_PREFIX+e),GM_setValue("librus_save_list",GM_getValue("librus_save_list",[]).filter(t=>t!==e)),GM_getValue("last_save")===e&&GM_setValue("last_save",DEFAULT_SAVE))}
    function togglePanelVisibility(e){const t=document.getElementById(e);t&&(t.style.display="none"===window.getComputedStyle(t).display?"block":"none")}
    function toggleSavesManagerVisibility(){let e=document.getElementById("librus-saves-manager");e?togglePanelVisibility("librus-saves-manager"):(createSavesManagerGui(),(e=document.getElementById("librus-saves-manager"))&&(e.style.display="block"),renderSavesList())}
    function mainHandleKeyDown(e){if(["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName))return;const t=e.key.toLowerCase();"a"===t?(e.preventDefault(),togglePanelVisibility("librus-grade-editor")):"s"===t&&(e.preventDefault(),toggleSavesManagerVisibility())}
    function initialHandleKeyDown(e){"a"===e.key.toLowerCase()&&!isInitialized&&(e.preventDefault(),waitForGradesAndInit())}
    function waitForGradesAndInit(){if(isInitialized)return;const e=document.createElement("div");e.id="lgs-loading-msg",e.textContent="Wczytywanie...",document.body.appendChild(e),e.style.display="block";const t=setInterval(()=>{const a=document.querySelector('h3.center + .right + table.decorated.stretch');a&&a.querySelector("tbody > tr")&&(clearInterval(t),e.remove(),console.log("Librus AdminPanel: Oceny załadowane. Inicjalizacja..."),extractGradesAndSubjects(),createAdminPanelGui(),document.getElementById("librus-grade-editor").style.display="block",loadSave(GM_getValue("last_save",DEFAULT_SAVE)),isInitialized=!0,document.removeEventListener("keydown",initialHandleKeyDown,!0),document.addEventListener("keydown",mainHandleKeyDown,!0))},200);setTimeout(()=>{isInitialized||(clearInterval(t),e.textContent="Błąd: Nie udało się wczytać ocen.",console.error("Librus AdminPanel: Timeout - nie znaleziono tabeli ocen."))},1e4)}
    document.addEventListener("keydown",initialHandleKeyDown,!0),console.log("✅ Librus AdminPanel v2.4.1 gotowy. Naciśnij [A], aby aktywować.");
})();
