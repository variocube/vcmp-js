import {expect} from "chai";
import {generateVcmpFrameId} from "@variocube/vcmp";

describe('frame', () => {
    it('can generate frame id', () => {
        const frameId = generateVcmpFrameId();
        expect(frameId).to.be.a('string').length(12);
    });
});