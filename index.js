const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const moment = require('moment');
const AdmZip = require('adm-zip');

/* ======================
    🔑 기본 설정
====================== */
const TELEGRAM_TOKEN = '8';
const DART_API_KEY = '';
const DART_LIST_URL = 'https://opendart.fss.or.kr/api/list.json';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

let isMonitoring = false;
let monitorTimer = null;
let targetChatId = null;
const sentSet = new Set();

/* ======================
    🔥 지능형 필터링 정규식
====================== */
const GOOD_REGEX = /단일판매|공급계약|무상증자|특허권|자기주식|제3자배정|양수도|투자판단|주요경영사항|기타\s*시장\s*안내|임상|FDA|승인|허가|기술이전|샌드박스|로봇|AI|탈모|신약/i;
const BAD_REGEX = /(주식처분|신탁계약|기재정정|계획|예정|검토|가능성|기대|준비중|추진)/i;
const HOT_KEYWORDS = new RegExp([
// [바이오 핵심]
    'FDA', 'EMA', 'PMDA',             // 해외 규제기관
    'CSR', '보고서\\s*수령',           // CSR 관련
    '임상\\s*시험\\s*결과\\s*보고서',    // 말씀하신 '임상시험결과보고서' 풀네임
    '임상\\s*([123]상)?\\s*(결과|승인|성공|완료|종료)', // 임상 단계별 성공/승인
    '통계적\\s*유의성', '탑라인', 'Top-line', // 임상 성공의 핵심 단어
    '품목\\s*허가', '최종\\s*승인',      // 허가 관련
    '기술\\s*이전', '기술\\s*수출', '라이선스\\s*아웃', // L/O 관련
    '신약\\s*허가', 'NDA', 'BLA','샌드박스',       // 신약 신청 관련
    // [로봇 핵심]
    '협동\\s*로봇', '자율\\s*주행', 'AMR', 'AGV', '감속기', '웨어러블', '휴머노이드', '페이로드', '서보\\s*모터',
    // [CES 및 IT 혁신]
    'CES', '혁신상', 'Innovation\\s*Award', '세계\\s*최초', '온디바이스\\s*AI', 'LLM', '생성형\\s*AI', 
    '디지털\\s*헬스', '스마트\\s*팩토리', '공정\\s*자동화'

].join('|'), 'i');


/* ======================
    🏷️ 호재 태그 생성 (분류 로직 보강)
====================== */
function extractHotKeyword(title, detail) {
    // 제목에 직접적으로 언급된 경우를 최우선으로!
    if (/임상|FDA|CSR|승인|탑라인/.test(title + detail)) return '🧬 바이오/기술 호재';
    if (/로봇|AMR|AGV|감속기|협동/.test(detail + title)) return '🤖 로봇/자동화';
    if (/CES|혁신상|AI|온디바이스/.test(detail + title)) return '🚀 신기술/CES';
    if (/단일판매|공급계약/.test(title)) return '💰 공급계약';
    if (/무상증자/.test(title)) return '📈 무상증자';
    if (/제3자배정/.test(title)) return '🤝 투자유치';
    return '🔔 주요공시';
}

/* ======================
    ⏰ 장 시간 체크 (09:00 ~ 15:40)
====================== */
function isMarketOpen() {
    const now = new Date();
    const day = now.getDay();
    const currentTime = now.getHours() * 100 + now.getMinutes();
    if (day === 0 || day === 6) return false;
    return currentTime >= 900 && currentTime <= 2140;
}

/* ======================
    🔍 본문 추출 및 정제
====================== */
async function getDartDetail(rcpNo) {
    const apiUrl = `https://opendart.fss.or.kr/api/document.xml?crtfc_key=${DART_API_KEY}&rcept_no=${rcpNo}`;
    try {
        const res = await axios.get(apiUrl, { responseType: 'arraybuffer', timeout: 10000 });
        const zip = new AdmZip(res.data);
        const zipEntries = zip.getEntries();
        if (zipEntries.length === 0) return "본문 파일 없음";
        
        let content = zipEntries[0].getData().toString('utf8');
        content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/\.[a-zA-Z0-9_.-]+\s*\{[\s\S]*?\}/g, "");
        
        let text = content.replace(/<[^>]*>?/g, " ").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
        const startIdx = text.search(/[제목|성명|1\.|【]/);
        if (startIdx !== -1) text = text.substring(startIdx);
        text = text.replace(/([0-9]\.) /g, "\n\n$1 ").replace(/([-·가-힣]\s*[:]) /g, "\n$1 ").replace(/\. /g, ".\n");

        return text.substring(0, 2000); 
    } catch (e) { return "본문 추출 실패: " + e.message; }
}


/* ======================
    🚀 통합 스캔 엔진 (날짜 지정 기능 추가)
===================== */
async function scanDart(count = 5, isTest = false, startDate = null, endDate = null) {
    if (!targetChatId) return;
    const logTime = moment().format('HH:mm:ss');

    // 테스트가 아닐 때만 장 시간 체크
    if (!isTest && !isMarketOpen()) {
        console.log(`[${logTime}][시스템] 장 운영 시간 외 대기 중...`);
        return;
    }

    try {
        // API 파라미터 구성
        const params = { 
            crtfc_key: DART_API_KEY, 
            page_count: count 
        };

        // 날짜 인자가 있으면 파라미터에 추가 (YYYYMMDD 형식)
        if (startDate) params.bgn_de = startDate;
        if (endDate) params.end_de = endDate;

        const res = await axios.get(DART_LIST_URL, { params, timeout: 10000 });
        if (res.data.status !== '000') {
            if (isTest) await bot.sendMessage(targetChatId, `❌ DART 에러: ${res.data.message}`);
            return;
        }

        const list = res.data.list.reverse();
        let matchCount = 0;

        for (const item of list) {
            const { report_nm: title, corp_name: corp, rcept_no: rcpNo } = item;
            const key = `${corp}_${rcpNo}`;

            const currentTime = moment().format('HH:mm:ss'); // 개별 공시 처리 시간

            if (!isTest && sentSet.has(key)) continue;

            // [로그] 1차 필터링(제외 대상)
            if (!GOOD_REGEX.test(title) || BAD_REGEX.test(title)) {
                console.log(`[${currentTime}][${corp}] [제외] ${title}`);
                continue;
            }

            const docDetail = await getDartDetail(rcpNo);
            let isPass = false;
            let extraInfo = "";

            // [로직 1] 수주/공급계약 (20% 필터링)
            if (title.includes("단일판매") || title.includes("공급계약")) {
                const ratioMatch = docDetail.match(/매출액\s*대비\s*.*?\s*([\d.]+)\s*%/);
                if (ratioMatch) {
                    const ratio = parseFloat(ratioMatch[1]);
                    if (ratio >= 20) {
                        isPass = true;
                        extraInfo = ratio >= 50 ? `\n🔥 <b>[초강력 수주] 매출액 대비 ${ratio}%!</b>` : `\n✅ <b>우량 수주: 매출액 대비 ${ratio}%</b>`;
                    }
                } else if (title.includes("기재정정")) {
                    isPass = true;
                    extraInfo = `\n🔄 <b>수주 내용 정정 공시 (기존 계약)</b>`;
                }
            } 
            // [로직 2] 부분을 아래 코드로 완전히 교체하세요
            else if (
                title.includes("임상") || 
                title.includes("탑라인") || 
                title.includes("기술이전") ||
                HOT_KEYWORDS.test(title + docDetail)
            ) {
                isPass = true; // 제목에 핵심 단어가 있으면 본문 내용과 관계없이 일단 패스!
                const tag = extractHotKeyword(title, docDetail);
                
                if (/결과|성공|승인|탑라인|확보/.test(title + docDetail)) {
                    extraInfo = `\n🔥 <b>[초강력 호재] 바이오 핵심 결과 발표!</b>`;
                } else {
                    extraInfo = `\n🧬 <b>[중요] 바이오 관련 공시 감지</b>`;
                }
            }
            // [로직 3] 지배구조 (무상증자, 양수도 등)
            else if (/(무상증자|양수도|최대주주)/.test(title)) {
                isPass = true;
                extraInfo = (docDetail.includes("연기") || docDetail.includes("지연")) 
                    ? `\n⚠️ <b>일정 연기/지연 주의</b>` 
                    : `\n📢 <b>기업 지배구조 중요 공시</b>`;
            }

            // [로그] 2차 필터링(미달 대상)
            if (!isPass) {
                console.log(`[${currentTime}][${corp}] [미달] ${title}`);
                continue;
            }

            // [로그] 최종 통과(전송 대상)
            console.log(`[${currentTime}][${corp}] [★발송] ${title}`);

            // 실시간일 때만 중복 방지 처리 및 메모리 관리
            if (!isTest) {
                sentSet.add(key);
                if (sentSet.size > 1000) {
                    const firstKey = sentSet.values().next().value;
                    sentSet.delete(firstKey);
                }
            }

            matchCount++;
            const hotTag = extractHotKeyword(title, docDetail);
            const link = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcpNo}`;
            const label = isTest ? "🧪 [과거 테스트]" : "🚨 [DART 감지]";
            
            await bot.sendMessage(targetChatId,
                `<b>${label}</b>\n\n` +
                `🏢 <b>기업명:</b> ${corp}\n` +
                `📄 <b>공시제목:</b> ${title}\n` +
                `${extraInfo}\n\n` +
                `📝 <b>요약:</b>\n<pre>${docDetail}</pre>\n\n` +
                `🏷️ <b>분류:</b> ${hotTag}\n` +
                `🔗 <a href="${link}">공시 원문 바로가기</a>`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            );

            if (isTest) await new Promise(r => setTimeout(r, 500));
        }
        
        if (isTest) bot.sendMessage(targetChatId, `🏁 테스트 완료 (분석: ${list.length}건 / 통과: ${matchCount}건)`);
    } catch (e) { console.error(`[에러] ${e.message}`); }
}


/* ======================
    🤖 명령어 처리
====================== */
bot.onText(/\/on/, (msg) => {
    targetChatId = msg.chat.id;
    if (!isMonitoring) {
        isMonitoring = true;
        bot.sendMessage(targetChatId, "🚀 <b>지능형 모니터링 가동</b>\n(수주 20% 필터 / 바이오·M&A 분석)");
        monitorTimer = setInterval(() => scanDart(5, false), 3000);
    }
});

bot.onText(/\/off/, (msg) => {
    isMonitoring = false; clearInterval(monitorTimer);
    bot.sendMessage(msg.chat.id, "🛑 <b>모니터링 중지</b>");
});

// 2. 과거 데이터 테스트 (최근 7일치를 명시적으로 요청)
bot.onText(/\/test100/, (msg) => {
    targetChatId = msg.chat.id;
    const end = moment().format('YYYYMMDD');
    const bgn = moment().subtract(2, 'days').format('YYYYMMDD');
    
    bot.sendMessage(targetChatId, `📊 <b>7일간의 데이터로 시뮬레이션 시작 (${bgn}~${end})</b>`);
    scanDart(100, true, bgn, end); // 100건, 테스트모드, 시작일, 종료일
});

console.log('🚀 DART 지능형 엔진 작동 중...');