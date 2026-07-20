// pc.go：P2P 建链底层——control/media/file 三类共用的**唯一**一份 PeerConnection 样板。
//
// 收敛前 link.go（持久 control/media PC）与 manager.go/transfer.go（临时 file PC）各写了一套
// 几乎相同的 PC 建链：NewPeerConnection→OnICECandidate 回信令→OnConnectionStateChange→
// classifyPath→SetRemote/CreateAnswer/SetLocal→回 answer→OnDataChannel 分派→AddICECandidate。
// 本文件把这套样板抽成一份，用 peerConfig 参数化「持久（按 class 键，随 WS 存活）」与
// 「临时（按 transferId 键，用完即拆）」两种生命周期与信令字段差异。
//
// 铁律：线协议一字不改。信令字段（class / transferId / type=answer|ice|connected|link）由
// peerConfig 决定，两类消费者填入各自原有字段，行为与收敛前逐字节一致。
package p2p

import (
	"encoding/json"
	"log"
	"sync/atomic"

	"github.com/pion/webrtc/v4"
)

// peer 是一条底层 PeerConnection 及其终结标志（持久 link 与临时 transfer 都内嵌它）。
// 生命周期策略（何时建、按什么键存、何时拆、拆时附带动作）由上层 link/transfer 决定，
// peer 只提供「建 + 挂回调 + 收 answer + 收 ice + 幂等关」这套共享机制。
type peer struct {
	pc        *webrtc.PeerConnection
	closed    int32 // 原子终结标志，幂等 close
	connected int32 // 原子：已进入 Connected
}

// peerConfig 参数化一条 PC 的信令字段与回调，抹平持久/临时两类的差异。
//
//   - keyLog：日志里标识本 PC 的键（link 用 "link=control"，transfer 用 "transfer=<id>"）。
//   - signalKey：填入回发信令的定位字段。link 填 Class，transfer 填 TransferID——
//     底层不感知语义，只把它塞进 SignalMsg 对应字段（见 sendICE/answer）。
//   - byClass：true=按 class 定位（Class 字段），false=按 transferId 定位（TransferID 字段）。
//   - verboseCand：是否逐条打印本/远端候选（link 需要复验 srflx，transfer 不打）。
//   - onConnected：Connected 时回调，带 classifyPath 结果；由上层发 link-up / connected 信令。
//   - onDown：Failed/Closed（及 link 的 Disconnected）时回调；由上层 finish/finishLink。
//   - onDataChannel：OnDataChannel 分派（link→dispatchDataChannel，transfer→serveFile/serveSpike）。
//   - downOnDisconnected：true=Disconnected 也触发 onDown（持久 link）；false=只 Failed/Closed（临时 transfer）。
type peerConfig struct {
	keyLog             string
	signalKey          string
	byClass            bool
	verboseCand        bool
	onConnected        func(path string, local, remote *CandInfo, rttMs int)
	onDown             func()
	onDataChannel      func(dc *webrtc.DataChannel)
	downOnDisconnected bool
}

// close 幂等关闭底层 PC。
func (p *peer) close() {
	if !atomic.CompareAndSwapInt32(&p.closed, 0, 1) {
		return
	}
	if p.pc != nil {
		_ = p.pc.Close()
	}
}

// newPeer 建一条 PC 并挂好共享回调（trickle ICE 回信令 / 连接状态 / classifyPath / DataChannel 分派）。
// 不设远端 SDP、不回 answer——那步由 answerOffer 完成（分开是为让上层在两步之间把 peer 存进表，
// 避免 answer 已回但 ICE 候选却找不到 PC 的竞态，与收敛前 link/transfer 的建表时机一致）。
func (s *session) newPeer(cfg peerConfig) (*peer, error) {
	pc, err := s.hub.api.NewPeerConnection(s.hub.rtcConfig)
	if err != nil {
		return nil, err
	}
	p := &peer{pc: pc}

	// trickle ICE：本端候选回传前端。link 逐条打印以复验 gather，transfer 不打。
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			if cfg.verboseCand {
				log.Printf("p2p: %s local-cand gathering-complete", cfg.keyLog)
			}
			return
		}
		if cfg.verboseCand {
			log.Printf("p2p: %s local-cand typ=%s proto=%s addr=%s:%d",
				cfg.keyLog, c.Typ.String(), c.Protocol.String(), c.Address, c.Port)
		}
		raw, err := json.Marshal(c.ToJSON())
		if err != nil {
			return
		}
		rm := json.RawMessage(raw)
		_ = s.send(s.iceMsg(cfg, &rm))
	})

	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		log.Printf("p2p: %s connectionState=%s", cfg.keyLog, st.String())
		switch st {
		case webrtc.PeerConnectionStateConnected:
			atomic.StoreInt32(&p.connected, 1)
			path, local, remote, rtt := classifyPath(pc, s.hub.upnpIP)
			if cfg.onConnected != nil {
				cfg.onConnected(path, local, remote, rtt)
			}
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			if cfg.onDown != nil {
				cfg.onDown()
			}
		case webrtc.PeerConnectionStateDisconnected:
			// 持久 link 把 Disconnected 也当断开（前端左边栏及时转 down）；
			// 临时 transfer 不理会 Disconnected（保持收敛前行为，只在 Failed/Closed 拆）。
			if cfg.downOnDisconnected && cfg.onDown != nil {
				cfg.onDown()
			}
		}
	})

	pc.OnDataChannel(cfg.onDataChannel)
	return p, nil
}

// answerOffer 设远端 offer、CreateAnswer、SetLocal，并回 answer 信令。任一步失败返回 error，
// 由上层 finish/finishLink 清理。SDP 与 answer 消息字段与收敛前逐字节一致。
func (s *session) answerOffer(p *peer, cfg peerConfig, offerSDP string) error {
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  offerSDP,
	}); err != nil {
		log.Printf("p2p: %s SetRemoteDescription: %v", cfg.keyLog, err)
		return err
	}
	ans, err := p.pc.CreateAnswer(nil)
	if err != nil {
		log.Printf("p2p: %s CreateAnswer: %v", cfg.keyLog, err)
		return err
	}
	if err := p.pc.SetLocalDescription(ans); err != nil {
		log.Printf("p2p: %s SetLocalDescription: %v", cfg.keyLog, err)
		return err
	}
	if err := s.send(s.answerMsg(cfg, ans.SDP)); err != nil {
		log.Printf("p2p: %s send answer: %v", cfg.keyLog, err)
		return err
	}
	return nil
}

// addRemoteICE 把远端 trickle 候选喂给 PC。link 打印远端候选以复验前端送没送 srflx。
func (s *session) addRemoteICE(p *peer, cfg peerConfig, cand *json.RawMessage) {
	if p == nil || cand == nil {
		return
	}
	var init webrtc.ICECandidateInit
	if err := json.Unmarshal(*cand, &init); err != nil {
		return
	}
	if cfg.verboseCand {
		if typ, addr := parseCandStr(init.Candidate); typ != "" {
			log.Printf("p2p: %s remote-cand typ=%s addr=%s", cfg.keyLog, typ, addr)
		} else if init.Candidate == "" {
			log.Printf("p2p: %s remote-cand end-of-candidates", cfg.keyLog)
		}
	}
	if err := p.pc.AddICECandidate(init); err != nil {
		log.Printf("p2p: %s AddICECandidate: %v", cfg.keyLog, err)
	}
}

// iceMsg / answerMsg 按 cfg.byClass 把定位字段填进 SignalMsg 对应位置（Class 或 TransferID），
// 保证回发线协议与收敛前一致：link 走 Class，transfer 走 TransferID。
func (s *session) iceMsg(cfg peerConfig, cand *json.RawMessage) SignalMsg {
	m := SignalMsg{Type: "ice", Candidate: cand}
	if cfg.byClass {
		m.Class = cfg.signalKey
	} else {
		m.TransferID = cfg.signalKey
	}
	return m
}

func (s *session) answerMsg(cfg peerConfig, sdp string) SignalMsg {
	m := SignalMsg{Type: "answer", SDP: sdp}
	if cfg.byClass {
		m.Class = cfg.signalKey
	} else {
		m.TransferID = cfg.signalKey
	}
	return m
}
