// --- State Variables ---
let board = null;
let game = new Chess();
let stockfish = null;
let isAiThinking = false;
let engineAction = 'idle'; 
let currentEvalScore = 0; 
let soundEnabled = true;
let timers = { w: 600, b: 600 }; 
let clockInterval = null;
let gameActive = false;
let selectedSquare = null;
let pendingPromotionMove = null;

// Online Multiplayer Variables
let peer = null;
let peerConnection = null;
let isReceivingMove = false; // ป้องกัน infinite loop ส่งข้อมูลไปมา
let myOnlineColor = 'w';     // กำหนดว่าเราสีอะไรในโหมดออนไลน์
let onlineRole = null;       // 'host' หรือ 'guest'

const pieceValues = { 'p': 1, 'n': 3, 'b': 3, 'r': 5, 'q': 9 };

const boardThemes = {
    slate: { light: '#e2e8f0', dark: '#64748b' },
    green: { light: '#ebecd0', dark: '#779556' },
    wood: { light: '#f0d9b5', dark: '#b58863' },
    blue: { light: '#dee3e6', dark: '#8ca2ad' }
};

// --- Web Audio API (Synthesizer) ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playSound(type) {
    if (!soundEnabled) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const now = audioCtx.currentTime;

    if (type === 'move') {
        osc.type = 'sine'; osc.frequency.setValueAtTime(400, now);
        osc.frequency.exponentialRampToValueAtTime(100, now + 0.1);
        gain.gain.setValueAtTime(0.5, now); gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        osc.start(now); osc.stop(now + 0.1);
    } else if (type === 'capture') {
        osc.type = 'square'; osc.frequency.setValueAtTime(300, now);
        osc.frequency.exponentialRampToValueAtTime(500, now + 0.1);
        gain.gain.setValueAtTime(0.3, now); gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        osc.start(now); osc.stop(now + 0.1);
    } else if (type === 'check') {
        osc.type = 'sawtooth'; osc.frequency.setValueAtTime(600, now);
        gain.gain.setValueAtTime(0.3, now); gain.gain.linearRampToValueAtTime(0, now + 0.2);
        osc.start(now); osc.stop(now + 0.2);
    } else if (type === 'gameover') {
        osc.type = 'triangle'; osc.frequency.setValueAtTime(300, now);
        osc.frequency.linearRampToValueAtTime(100, now + 0.8);
        gain.gain.setValueAtTime(0.5, now); gain.gain.linearRampToValueAtTime(0, now + 0.8);
        osc.start(now); osc.stop(now + 0.8);
    }
}

// --- PeerJS / Online Logic ---
function initPeer() {
    if (peer) return;
    $('#onlineStatus').text('Status: Connecting to PeerJS server...').removeClass('text-emerald-400').addClass('text-amber-400');
    
    peer = new Peer();
    
    peer.on('open', function(id) {
        $('#myPeerId').val(id);
        $('#onlineStatus').text('Status: Waiting for friend to join...');
    });

    // เมื่อมีคน (Guest) พยายามเชื่อมต่อมาหาเรา (Host)
    peer.on('connection', function(conn) {
        peerConnection = conn;
        onlineRole = 'host';
        setupConnectionHandlers(conn);
        $('#onlineStatus').text('Status: Friend joined! Click Start Game.').removeClass('text-amber-400').addClass('text-emerald-400');
        $('#joinPeerBtn').prop('disabled', true);
        $('#joinPeerId').prop('disabled', true);
    });

    peer.on('error', function(err) {
        console.error(err);
        $('#onlineStatus').text('Status: Error (' + err.type + ')').removeClass('text-emerald-400').addClass('text-red-400');
    });
}

function connectToPeer(id) {
    if (!peer) return;
    $('#onlineStatus').text('Status: Connecting to host...').removeClass('text-emerald-400 text-red-400').addClass('text-amber-400');
    const conn = peer.connect(id);
    
    conn.on('open', function() {
        peerConnection = conn;
        onlineRole = 'guest';
        setupConnectionHandlers(conn);
        $('#onlineStatus').text('Status: Connected! Waiting for host to start...').removeClass('text-amber-400').addClass('text-emerald-400');
        // Guest ไม่มีสิทธิ์กดเริ่มเกมเอง ต้องรอ Host
        $('#startGameBtn').prop('disabled', true).addClass('opacity-50 cursor-not-allowed');
    });
}

// รับข้อมูลจากอีกฝั่ง
function setupConnectionHandlers(conn) {
    conn.on('data', function(data) {
        
        if (data.type === 'start') {
            // Guest ได้รับคำสั่งให้เริ่มเกมจาก Host
            myOnlineColor = data.guestColor;
            
            // ตั้งค่า UI ให้เหมือน Host
            const selectedTheme = boardThemes[data.theme];
            document.documentElement.style.setProperty('--board-light', selectedTheme.light);
            document.documentElement.style.setProperty('--board-dark', selectedTheme.dark);
            
            timers = { w: data.time, b: data.time }; 
            
            $('#setupScreen').removeClass('flex').addClass('hidden');
            $('#mainGameUI').removeClass('hidden').addClass('flex');
            board.resize();
            
            game.reset(); 
            board.orientation(myOnlineColor === 'w' ? 'white' : 'black');
            board.start(); 
            
            isAiThinking = false; engineAction = 'idle';
            $('#evalBarWhite').css('height', '50%');
            $('#evalText').text('0.0').removeClass('text-slate-800').addClass('text-slate-400');
            
            stopClock();
            updateUI(); updateClockUI(); requestEvaluation();
        } 
        else if (data.type === 'move') {
            // ได้รับตาเดินจากเพื่อน
            isReceivingMove = true;
            let m = game.move(data.move);
            if(m) {
                timers = data.timers; // ซิงค์เวลา
                board.position(game.fen());
                afterMove(m);
            }
            isReceivingMove = false;
        }
        else if (data.type === 'resign') {
            stopClock(); gameActive = false;
            $('#statusTitle').text("Opponent Resigned"); 
            $('#statusDesc').text(`You win by resignation.`);
            showModal("Victory!", `Opponent resigned.`, "fa-crown", "text-yellow-400");
            playSound('gameover');
        }
        else if (data.type === 'draw_offer') {
            if (confirm("Opponent offers a draw. Do you accept?")) {
                peerConnection.send({ type: 'draw_accept' });
                stopClock(); gameActive = false;
                $('#statusTitle').text("Draw Agreed"); 
                $('#statusDesc').text(`Game drawn by agreement.`);
                showModal("Draw", `Draw by agreement.`, "fa-handshake", "text-slate-400");
                playSound('gameover');
            }
        }
        else if (data.type === 'draw_accept') {
            stopClock(); gameActive = false;
            $('#statusTitle').text("Draw Agreed"); 
            $('#statusDesc').text(`Opponent accepted the draw.`);
            showModal("Draw", `Draw by agreement.`, "fa-handshake", "text-slate-400");
            playSound('gameover');
        }
    });

    conn.on('close', function() {
        alert("Peer disconnected.");
        peerConnection = null;
        onlineRole = null;
        $('#newGameBtn').click(); // กลับหน้า Setup
    });
}

// --- Initialization Stockfish ---
function initStockfish() {
    fetch('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js')
        .then(res => res.text())
        .then(script => {
            const blob = new Blob([script], { type: 'application/javascript' });
            stockfish = new Worker(URL.createObjectURL(blob));
            
            stockfish.onmessage = function(event) {
                const line = event.data;
                if (line.includes("info") && line.includes("score")) {
                    const cpMatch = line.match(/score cp (-?\d+)/);
                    const mateMatch = line.match(/score mate (-?\d+)/);
                    let score = 0, isMate = false;
                    
                    if (cpMatch) score = parseInt(cpMatch[1], 10);
                    else if (mateMatch) { score = parseInt(mateMatch[1], 10); isMate = true; }
                    
                    let whiteScore = game.turn() === 'w' ? score : -score;
                    currentEvalScore = whiteScore;
                    
                    let displayScore = "";
                    if (isMate) displayScore = (whiteScore > 0 ? "+M" : "-M") + Math.abs(score);
                    else displayScore = (whiteScore > 0 ? "+" : "") + (whiteScore / 100).toFixed(1);
                    
                    $('#evalText').text(displayScore);
                    let cap = 800;
                    let evalClamped = Math.max(-cap, Math.min(cap, whiteScore));
                    let percentage = 50 + (evalClamped / cap) * 45;
                    
                    $('#evalBarWhite').css('height', percentage + '%');
                    $('#evalText').toggleClass('text-slate-800', percentage > 55).toggleClass('text-slate-400', percentage <= 55);
                }

                if (line.includes("bestmove")) {
                    const match = line.match(/^bestmove\s([a-h][1-8][a-h][1-8][qrbn]?)/);
                    if (match) {
                        if (engineAction === 'move') executeAiMove(match[1]);
                        else if (engineAction === 'hint') showHint(match[1]);
                    }
                    engineAction = 'idle'; isAiThinking = false;
                }
            };
            stockfish.postMessage("uci"); stockfish.postMessage("ucinewgame");
        })
        .catch(err => console.error("Stockfish load error:", err));
}

function makeAiMove() {
    if (!stockfish || game.game_over()) return;
    engineAction = 'move'; isAiThinking = true; updateUI();
    const diff = $('#difficulty').val();
    let depth = 5, movetime = 500;
    if (diff === 'medium') { depth = 10; movetime = 1500; }
    if (diff === 'hard') { depth = 15; movetime = 3000; }
    stockfish.postMessage(`position fen ${game.fen()}`);
    stockfish.postMessage(`go depth ${depth} movetime ${movetime}`);
}

function requestEvaluation() {
    if (!stockfish || game.game_over() || engineAction === 'move') return;
    engineAction = 'eval';
    stockfish.postMessage(`position fen ${game.fen()}`);
    stockfish.postMessage(`go depth 8`); 
}

function executeAiMove(moveStr) {
    const move = game.move({ from: moveStr.substring(0, 2), to: moveStr.substring(2, 4), promotion: moveStr.length > 4 ? moveStr.charAt(4) : undefined });
    isAiThinking = false; engineAction = 'idle';
    if (move) { board.position(game.fen(), true); afterMove(move); }
}

function isPromotionMove(from, to) {
    const moves = game.moves({ verbose: true });
    return moves.some(m => m.from === from && m.to === to && m.promotion);
}

function showPromotionModal(color) {
    const pieces = ['q', 'r', 'n', 'b'];
    $('#promoPieces').empty();
    pieces.forEach(p => {
        const imgUrl = `https://chessboardjs.com/img/chesspieces/wikipedia/${color}${p.toUpperCase()}.png`;
        $('#promoPieces').append(`<img src="${imgUrl}" class="w-16 h-16 cursor-pointer hover:scale-110 transition bg-slate-700/50 rounded-lg p-2 border border-slate-600 hover:border-indigo-400" onclick="completePromotion('${p}')">`);
    });
    $('#promotionModal').removeClass('hidden').addClass('flex');
}

window.completePromotion = function(pieceType) {
    $('#promotionModal').addClass('hidden').removeClass('flex');
    if (!pendingPromotionMove) return;
    let move = game.move({ from: pendingPromotionMove.from, to: pendingPromotionMove.to, promotion: pieceType });
    pendingPromotionMove = null; clearSelection();
    if (move) { board.position(game.fen()); afterMove(move); }
}

function selectSquare(square) {
    selectedSquare = square;
    $('.square-55d63').removeClass('highlight-hint highlight-possible capture-move highlight-selected');
    $('.square-' + square).addClass('highlight-selected');
    const moves = game.moves({ square: square, verbose: true });
    moves.forEach(move => {
        const squareEl = $('.square-' + move.to);
        squareEl.addClass('highlight-possible');
        if (move.captured) squareEl.addClass('capture-move');
    });
}

function clearSelection() {
    selectedSquare = null;
    $('.square-55d63').removeClass('highlight-possible capture-move highlight-selected');
}

function onDragStart(source, piece) {
    if (game.game_over() || isAiThinking) return false;
    
    const mode = $('#gameMode').val();
    const turn = game.turn();
    
    // โหมด AI: ห้ามจับหมาก AI
    if (mode === 'ai' && turn !== $('#playerColor').val()) return false;
    
    // โหมด Online: ห้ามจับหมากที่ไม่ใช่สีเรา หรือห้ามเดินถ้าไม่ใช่ตาเรา
    if (mode === 'online') {
        if (turn !== myOnlineColor) return false;
        if (piece.search(myOnlineColor) === -1) return false;
    }
    
    if (piece.search(turn) === -1) {
        if (!selectedSquare) return false;
    } else {
        selectSquare(source);
    }
}

function onDrop(source, target) {
    if (source === target) return 'snapback';
    if (isPromotionMove(source, target)) {
        pendingPromotionMove = { from: source, to: target };
        showPromotionModal(game.turn());
        return 'snapback'; 
    }
    $('.square-55d63').removeClass('highlight-hint highlight-possible capture-move highlight-selected');
    let move = game.move({ from: source, to: target });
    
    if (move === null) { clearSelection(); return 'snapback'; }
    clearSelection();
    afterMove(move);
}

function onSnapEnd() { board.position(game.fen()); }

function afterMove(move) {
    if (game.in_checkmate() || game.in_draw()) { playSound('gameover'); updateEvalForGameOver(); } 
    else if (game.in_check()) { playSound('check'); } 
    else if (move.captured) { playSound('capture'); } 
    else { playSound('move'); }

    if (!gameActive && !game.game_over()) startClock();
    updateUI();

    const mode = $('#gameMode').val();
    const pColor = $('#playerColor').val();

    // 🔴 ส่งข้อมูลข้ามเครือข่ายสำหรับ Online Mode
    if (mode === 'online' && !isReceivingMove && peerConnection) {
        peerConnection.send({
            type: 'move',
            move: { from: move.from, to: move.to, promotion: move.promotion },
            timers: timers
        });
    }

    if (mode === 'pvp') {
        setTimeout(() => { board.orientation(game.turn() === 'w' ? 'white' : 'black'); updateCapturedPieces(); updatePlayerLabels(); requestEvaluation(); }, 500);
    } else if (mode === 'ai' && !game.game_over()) {
        if (game.turn() !== pColor) setTimeout(makeAiMove, 250);
        else requestEvaluation();
    } else if (mode === 'online' && !game.game_over()) {
        requestEvaluation(); // สั่งอัปเดต Eval ในโหมดออนไลน์ด้วย
    }
}

function updateEvalForGameOver() {
    if (game.in_checkmate()) {
        const winner = game.turn() === 'w' ? 'Black' : 'White';
        if (winner === 'White') { $('#evalBarWhite').css('height', '100%'); $('#evalText').text('+M0'); } 
        else { $('#evalBarWhite').css('height', '0%'); $('#evalText').text('-M0'); }
    } else {
        $('#evalBarWhite').css('height', '50%'); $('#evalText').text('0.0');
    }
}

function updateUI() {
    updateHighlights(); updateHistory(); updateCapturedPieces(); updateStatus(); updatePlayerLabels();
}

function updatePlayerLabels() {
    const mode = $('#gameMode').val();
    const currentOrientation = board.orientation();
    const userIcon = '<i class="fa-regular fa-user"></i>';
    const aiIcon = '<i class="fa-solid fa-robot text-slate-300"></i>';
    const friendIcon = '<i class="fa-solid fa-user-group text-sky-300"></i>';
    
    if (mode === 'pvp') {
        $('#bottomPlayerName').text(currentOrientation === 'white' ? 'White' : 'Black');
        $('#topPlayerName').text(currentOrientation === 'white' ? 'Black' : 'White');
        $('#bottomPlayerIcon').html(userIcon).removeClass('bg-slate-700 bg-sky-700').addClass('bg-indigo-600');
        $('#topPlayerIcon').html(userIcon).removeClass('bg-slate-700 bg-sky-700').addClass('bg-indigo-600');
    } else if (mode === 'online') {
        $('#bottomPlayerName').text('You (' + (myOnlineColor === 'w' ? 'White' : 'Black') + ')');
        $('#topPlayerName').text('Opponent (' + (myOnlineColor === 'w' ? 'Black' : 'White') + ')');
        $('#bottomPlayerIcon').html(userIcon).removeClass('bg-slate-700 bg-sky-700').addClass('bg-indigo-600');
        $('#topPlayerIcon').html(friendIcon).removeClass('bg-indigo-600 bg-slate-700').addClass('bg-sky-800');
    } else { // AI
        const pColor = $('#playerColor').val();
        const aiText = `AI (${$('#difficulty option:selected').text().split(' ')[0]})`;
        if (pColor === 'w') {
            $('#bottomPlayerName').text('You (White)'); $('#topPlayerName').text(aiText);
            $('#bottomPlayerIcon').html(userIcon).removeClass('bg-slate-700 bg-sky-700').addClass('bg-indigo-600');
            $('#topPlayerIcon').html(aiIcon).removeClass('bg-indigo-600 bg-sky-700').addClass('bg-slate-700');
        } else {
            $('#bottomPlayerName').text(aiText); $('#topPlayerName').text('You (Black)');
            $('#bottomPlayerIcon').html(aiIcon).removeClass('bg-indigo-600 bg-sky-700').addClass('bg-slate-700');
            $('#topPlayerIcon').html(userIcon).removeClass('bg-slate-700 bg-sky-700').addClass('bg-indigo-600');
        }
    }
}

function updateHighlights() {
    $('.square-55d63').removeClass('highlight-last-move highlight-check');
    const history = game.history({ verbose: true });
    if (history.length > 0) {
        const last = history[history.length - 1];
        $('.square-' + last.from).addClass('highlight-last-move');
        $('.square-' + last.to).addClass('highlight-last-move');
    }
    if (game.in_check()) {
        const kingColor = game.turn() === 'w' ? 'w' : 'b';
        for (let r = 1; r <= 8; r++) {
            for (let c = 0; c < 8; c++) {
                const sq = 'abcdefgh'[c] + r;
                const p = game.get(sq);
                if (p && p.type === 'k' && p.color === kingColor) $('.square-' + sq).addClass('highlight-check');
            }
        }
    }
}

function showHint(moveStr) {
    $('.square-' + moveStr.substring(0, 2)).addClass('highlight-hint');
    $('.square-' + moveStr.substring(2, 4)).addClass('highlight-hint');
}

function updateStatus() {
    let title = game.turn() === 'w' ? "White's Turn" : "Black's Turn";
    let desc = "Make your move.";
    let bannerClass = "bg-slate-800 border-slate-600";
    let iconClass = "fa-circle-info text-slate-400";
    let isGameOver = false; let modalTitle = "", modalDesc = "", modalIcon = "", modalColor = "";

    if (game.in_checkmate()) {
        const winner = game.turn() === 'w' ? 'Black' : 'White';
        title = `Checkmate! ${winner} wins!`; desc = "Game over."; 
        bannerClass = "bg-red-900/40 border-red-500/50"; iconClass = "fa-skull text-red-400";
        stopClock(); isGameOver = true; modalTitle = "Checkmate!"; modalDesc = `${winner} wins the game.`;
        modalIcon = "fa-crown"; modalColor = "text-yellow-400";
    } else if (game.in_draw()) {
        title = "Game Drawn"; desc = game.in_stalemate() ? "Stalemate" : "Repetition/Material/50-move rule";
        bannerClass = "bg-amber-900/30 border-amber-500/50"; iconClass = "fa-handshake text-amber-400";
        stopClock(); isGameOver = true; modalTitle = "Draw!"; modalDesc = "Game ended in a draw. (" + desc + ")";
        modalIcon = "fa-handshake"; modalColor = "text-slate-400";
    } else if (game.in_check()) {
        desc = "Check!"; bannerClass = "bg-orange-900/30 border-orange-500/50"; iconClass = "fa-triangle-exclamation text-orange-400";
    } else if (isAiThinking) {
        title = "AI is thinking..."; desc = "Please wait."; iconClass = "fa-spinner fa-spin text-indigo-400";
    }

    $('#statusTitle').text(title); $('#statusDesc').text(desc);
    $('#statusBanner').removeClass().addClass(`border p-4 rounded-xl flex items-start gap-3 transition-colors ${bannerClass}`);
    $('#statusBanner i').removeClass().addClass(`fa-solid mt-1 ${iconClass}`);

    if (isGameOver) showModal(modalTitle, modalDesc, modalIcon, modalColor);
}

function showModal(title, desc, iconClass, colorClass) {
    $('#modalTitle').text(title); $('#modalDesc').text(desc);
    $('#modalIcon').removeClass().addClass(`fa-solid ${iconClass} text-6xl mb-4 ${colorClass}`);
    $('#gameOverModal').removeClass('hidden').addClass('flex');
    setTimeout(() => { $('#gameOverModal > div').removeClass('scale-95').addClass('scale-100'); }, 10);
}

function updateHistory() {
    const history = game.history(); $('#moveCount').text(history.length + ' moves');
    const tbody = $('#historyBody').empty();
    for (let i = 0; i < history.length; i += 2) {
        tbody.append(`<tr class="border-b border-slate-700/50 hover:bg-slate-700/30 transition">
            <td class="py-2 text-slate-500">${(i/2)+1}.</td><td class="py-2">${history[i]}</td><td class="py-2">${history[i+1] || ''}</td>
        </tr>`);
    }
    const container = $('#historyBody').parent().parent()[0];
    container.scrollTop = container.scrollHeight;
}

function updateCapturedPieces() {
    let capW = [], capB = [];
    game.history({ verbose: true }).forEach(m => { if (m.captured) m.color === 'w' ? capB.push(m.captured) : capW.push(m.captured); });
    const sortP = (a, b) => pieceValues[b] - pieceValues[a];
    capW.sort(sortP); capB.sort(sortP);

    const img = (c, p) => `<img src="https://chessboardjs.com/img/chesspieces/wikipedia/${c}${p.toUpperCase()}.png" class="w-5 h-5 -ml-1 drop-shadow-md">`;
    if (board.orientation() === 'white') {
        $('#top-captured').html(capW.map(p => img('w', p)).join('')); $('#bottom-captured').html(capB.map(p => img('b', p)).join(''));
    } else {
        $('#top-captured').html(capB.map(p => img('b', p)).join('')); $('#bottom-captured').html(capW.map(p => img('w', p)).join(''));
    }
}

function fmtTime(s) { return `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`; }
function startClock() {
    gameActive = true;
    if(clockInterval) clearInterval(clockInterval);
    clockInterval = setInterval(() => {
        timers[game.turn()]--; updateClockUI();
        if(timers[game.turn()] <= 0) {
            stopClock(); const winner = game.turn() === 'w' ? 'Black' : 'White';
            $('#statusTitle').text("Timeout!"); $('#statusDesc').text(`${winner} wins on time.`);
            showModal("Time's Up!", `${winner} wins on time.`, "fa-hourglass-end", "text-red-500");
            playSound('gameover'); gameActive = false;
        }
    }, 1000);
}
function stopClock() { clearInterval(clockInterval); updateClockUI(); }

function updateClockUI() {
    const o = board.orientation();
    $('#top-clock').text(fmtTime(o === 'white' ? timers.b : timers.w));
    $('#bottom-clock').text(fmtTime(o === 'white' ? timers.w : timers.b));
    $('#top-clock, #bottom-clock').removeClass('text-emerald-400 text-slate-400');
    if (gameActive) {
        if ((o === 'white' && game.turn() === 'w') || (o === 'black' && game.turn() === 'b')) {
            $('#bottom-clock').addClass('text-emerald-400'); $('#top-clock').addClass('text-slate-400');
        } else {
            $('#top-clock').addClass('text-emerald-400'); $('#bottom-clock').addClass('text-slate-400');
        }
    } else {
        $('#top-clock, #bottom-clock').addClass('text-slate-400');
    }
}

// --- Events Setup ---
$('#gameMode').change(function() {
    const v = $(this).val();
    $('#difficultyContainer').toggle(v === 'ai');
    $('#colorConfig').toggle(v === 'ai' || v === 'online');
    
    if (v === 'online') {
        $('#onlineConfig').removeClass('hidden').addClass('flex');
        initPeer();
        $('#startGameBtn').prop('disabled', true).addClass('opacity-50 cursor-not-allowed');
    } else {
        $('#onlineConfig').addClass('hidden').removeClass('flex');
        $('#startGameBtn').prop('disabled', false).removeClass('opacity-50 cursor-not-allowed');
        // Clean up peer if leaving online mode
        if (peerConnection) { peerConnection.close(); peerConnection = null; }
        if (peer) { peer.destroy(); peer = null; }
    }
});

$('#copyPeerIdBtn').click(function() {
    const input = document.getElementById("myPeerId");
    input.select(); document.execCommand("copy");
    $(this).html('<i class="fa-solid fa-check text-emerald-400"></i>');
    setTimeout(() => $(this).html('<i class="fa-solid fa-copy"></i>'), 2000);
});

$('#joinPeerBtn').click(function() {
    const id = $('#joinPeerId').val().trim();
    if (id) connectToPeer(id);
});

$('#startGameBtn').click(() => {
    const mode = $('#gameMode').val();
    if (mode === 'online' && !peerConnection) {
        alert("Please wait for a friend to connect or join a room first.");
        return;
    }

    $('#setupScreen').removeClass('flex').addClass('hidden');
    $('#mainGameUI').removeClass('hidden').addClass('flex');
    board.resize();

    const selectedTheme = boardThemes[$('#boardTheme').val()];
    document.documentElement.style.setProperty('--board-light', selectedTheme.light);
    document.documentElement.style.setProperty('--board-dark', selectedTheme.dark);

    const selectedTime = parseInt($('#timeControl').val(), 10);
    timers = { w: selectedTime, b: selectedTime }; 
    
    const pColor = mode === 'pvp' ? 'w' : $('#playerColor').val(); 
    
    if (mode === 'online') {
        myOnlineColor = pColor;
        const guestColor = pColor === 'w' ? 'b' : 'w';
        peerConnection.send({
            type: 'start',
            time: selectedTime,
            theme: $('#boardTheme').val(),
            guestColor: guestColor
        });
        $('#hintBtn, #undoBtn').hide(); // Hide single-player tools
    } else {
        $('#hintBtn, #undoBtn').show();
    }
    
    game.reset(); 
    board.orientation(pColor === 'w' ? 'white' : 'black');
    board.start(); 
    
    isAiThinking = false; engineAction = 'idle';
    $('#evalBarWhite').css('height', '50%'); $('#evalText').text('0.0').removeClass('text-slate-800').addClass('text-slate-400');
    
    stopClock(); updateUI(); updateClockUI();
    
    if(mode === 'ai') {
        stockfish.postMessage("ucinewgame");
        if (pColor === 'b') setTimeout(makeAiMove, 250);
        else requestEvaluation();
    } else {
        requestEvaluation();
    }
});

$('#newGameBtn').click(() => {
    if(game.history().length > 0 && !game.game_over()) {
        if(!confirm("Game in progress. Are you sure you want to abandon it?")) return;
    }
    stopClock(); gameActive = false;
    
    if (peerConnection) {
        peerConnection.close(); peerConnection = null;
    }
    if (peer) {
        peer.destroy(); peer = null;
        $('#gameMode').val('ai').trigger('change');
    }

    $('#mainGameUI').removeClass('flex').addClass('hidden');
    $('#setupScreen').removeClass('hidden').addClass('flex');
});

$('#undoBtn').click(() => {
    if(isAiThinking || game.history().length === 0 || $('#gameMode').val() === 'online') return;
    game.undo(); if($('#gameMode').val() === 'ai') game.undo();
    board.position(game.fen()); updateUI(); requestEvaluation();
    if(game.history().length === 0) stopClock();
});

$('#hintBtn').click(() => {
    if(isAiThinking || game.game_over() || engineAction === 'move' || $('#gameMode').val() === 'online') return;
    $('.square-55d63').removeClass('highlight-hint');
    engineAction = 'hint';
    stockfish.postMessage(`position fen ${game.fen()}`);
    stockfish.postMessage(`go depth 10`);
});

$('#resignBtn').click(() => {
    if (game.game_over() || !gameActive) return;
    if (confirm("Are you sure you want to resign?")) {
        if ($('#gameMode').val() === 'online' && peerConnection) {
            peerConnection.send({ type: 'resign' });
        }
        stopClock(); gameActive = false;
        const loser = game.turn() === 'w' ? 'White' : 'Black';
        const winner = game.turn() === 'w' ? 'Black' : 'White';
        $('#statusTitle').text("Resignation"); $('#statusDesc').text(`${loser} resigned.`);
        showModal("Resignation", `You resigned. ${winner} wins.`, "fa-flag", "text-slate-400");
        playSound('gameover');
    }
});

$('#drawBtn').click(() => {
    if (game.game_over() || !gameActive) return;
    
    const mode = $('#gameMode').val();
    if (mode === 'online' && peerConnection) {
        peerConnection.send({ type: 'draw_offer' });
        alert("Draw offer sent. Waiting for opponent...");
    } else if (mode === 'ai') {
        const aiScore = ($('#playerColor').val() === 'w' ? -currentEvalScore : currentEvalScore);
        if (aiScore > 100) alert("AI declines the draw offer.");
        else {
            if (confirm("AI accepts the draw. End game?")) {
                stopClock(); gameActive = false;
                $('#statusTitle').text("Draw Agreed"); $('#statusDesc').text(`The game is a draw by agreement.`);
                showModal("Draw", `Draw by agreement.`, "fa-handshake", "text-slate-400");
                playSound('gameover');
            }
        }
    } else {
        if (confirm("Player offers a draw. Do you accept?")) {
            stopClock(); gameActive = false;
            $('#statusTitle').text("Draw Agreed"); $('#statusDesc').text(`The game is a draw by agreement.`);
            showModal("Draw", `Draw by agreement.`, "fa-handshake", "text-slate-400");
            playSound('gameover');
        }
    }
});

$('#soundBtn').click(() => {
    soundEnabled = !soundEnabled; const i = $('#soundIcon');
    if(soundEnabled) i.removeClass('fa-volume-xmark text-slate-500').addClass('fa-volume-high text-indigo-400');
    else i.removeClass('fa-volume-high text-indigo-400').addClass('fa-volume-xmark text-slate-500');
});

$('#pgnBtn').click(() => {
    const pgn = game.pgn(); if(!pgn) return alert("No moves yet.");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([pgn], {type: "text/plain"}));
    a.download = "elite_chess.pgn"; a.click();
});

$('#modalCloseBtn').click(() => {
    $('#gameOverModal').removeClass('flex').addClass('hidden');
    $('#gameOverModal > div').removeClass('scale-100').addClass('scale-95');
});

$('#modalPlayAgainBtn').click(() => {
    $('#modalCloseBtn').click(); $('#newGameBtn').click();
});

// --- Start App ---
$(document).ready(function() {
    board = Chessboard('board', {
        draggable: true, position: 'start',
        onDragStart: onDragStart, onDrop: onDrop, onSnapEnd: onSnapEnd,
        pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png'
    });
    
    $(window).resize(board.resize);
    initStockfish();

    let lastTap = 0;
    $('#board').on('mousedown touchstart', '.square-55d63', function(e) {
        const timeNow = new Date().getTime();
        if (timeNow - lastTap < 100) return;
        lastTap = timeNow;

        if (!selectedSquare) return;

        const square = $(this).attr('data-square');
        const piece = game.get(square);
        const turn = game.turn();
        
        const mode = $('#gameMode').val();
        if (mode === 'ai' && turn !== $('#playerColor').val()) return;
        if (mode === 'online' && turn !== myOnlineColor) return;
        
        if (piece && piece.color === turn) { selectSquare(square); return; }

        if (isPromotionMove(selectedSquare, square)) {
            pendingPromotionMove = { from: selectedSquare, to: square };
            showPromotionModal(game.turn());
            e.preventDefault();
            return;
        }

        const move = game.move({ from: selectedSquare, to: square });
        if (move) {
            board.position(game.fen()); clearSelection(); afterMove(move); e.preventDefault();
        } else {
            clearSelection();
        }
    });
});