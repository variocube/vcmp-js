import {expect} from "chai";
import {generateVcmpFrameId, serializeVcmpFrame} from "@variocube/vcmp";
import {parseVcmpFrame} from "../src";

describe('frame', () => {
    it('can generate frame id', () => {
        const frameId = generateVcmpFrameId();
        expect(frameId).to.be.a('string').length(12);
    });

	it('can serialize a message frame', () => {
		const frame = serializeVcmpFrame({type: "MSG", id: "123456789012", payload: "foo"});
		expect(frame).to.be.eq("MSG123456789012foo");
	});

	it("can serialize an ACK frame without payload", () => {
		const frame = serializeVcmpFrame({type: "ACK", id: "123456789012"});
		expect(frame).to.be.eq("ACK123456789012");
	});

	it("can serialize an ACK frame with payload", () => {
		const frame = serializeVcmpFrame({type: "ACK", id: "123456789012", payload: "bar"});
		expect(frame).to.be.eq("ACK123456789012bar");
	});

	it("can serialize a NAK frame without payload", () => {
		const frame = serializeVcmpFrame({type: "NAK", id: "123456789012"});
		expect(frame).to.be.eq("NAK123456789012");
	});

	it("can serialize a NAK frame with payload", () => {
		const frame = serializeVcmpFrame({type: "NAK", id: "123456789012", payload: "foo"});
		expect(frame).to.be.eq("NAK123456789012foo");
	});

	it("can serialize a HBT frame", () => {
		const frame = serializeVcmpFrame({type: "HBT", heartbeatInterval: 1000});
		expect(frame).to.be.eq("HBT1000");
	});

	it("can parse a MSG frame", () => {
		const frame = parseVcmpFrame("MSG123456789012foo");
		expect(frame).to.be.deep.eq({type: "MSG", id: "123456789012", payload: "foo"});
	});

	it("can parse an ACK frame without payload", () => {
		const frame = parseVcmpFrame("ACK123456789012");
		expect(frame).to.be.deep.eq({type: "ACK", id: "123456789012", payload: undefined});
	});

	it("can parse an ACK frame with payload", () => {
		const frame = parseVcmpFrame("ACK123456789012foo");
		expect(frame).to.be.deep.eq({type: "ACK", id: "123456789012", payload: "foo"});
	});

	it("can parse a NAK frame without payload", () => {
		const frame = parseVcmpFrame("NAK123456789012");
		expect(frame).to.be.deep.eq({type: "NAK", id: "123456789012", payload: undefined});
	});

	it("can parse a NAK frame with payload", () => {
		const frame = parseVcmpFrame("NAK123456789012foo");
		expect(frame).to.be.deep.eq({type: "NAK", id: "123456789012", payload: "foo"});
	});

	it("can parse a HBT frame", () => {
		const frame = parseVcmpFrame("HBT1000");
		expect(frame).to.be.deep.eq({type: "HBT", heartbeatInterval: 1000});
	});
});
