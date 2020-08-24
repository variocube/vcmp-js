import {expect} from "chai";
import {generateVcmpFrameId} from "../src/frame";

describe('frame', () => {
    it('can generate frame id', () => {
        const frameId = generateVcmpFrameId();
        expect(frameId).to.be.a('string').length(12);
    });
});