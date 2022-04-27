import { Observable, Subject, mergeMap } from 'rxjs';
import { on } from 'subscribable-things';
import { ICandidateEvent, IDescriptionEvent, IRequestEvent, ISummaryEvent } from '../interfaces';
import { TClientEvent } from '../types';

export const negotiateDataChannels = (createPeerConnection: () => RTCPeerConnection, webSocket: WebSocket) =>
    mergeMap(
        ([clientId, subject]: [string, Subject<IRequestEvent | TClientEvent>]) =>
            new Observable<RTCDataChannel>((observer) => {
                const peerConnection = createPeerConnection();
                const receivedCandidates: RTCIceCandidateInit[] = [];
                const send = (event: TClientEvent) => webSocket.send(JSON.stringify(event));

                let numberOfAppliedCandidates = 0;
                let numberOfExpectedCandidates = Infinity;
                let numberOfGatheredCandidates = 0;

                peerConnection.addEventListener('icecandidate', ({ candidate }) => {
                    if (candidate === null) {
                        send({
                            client: { id: clientId },
                            numberOfGatheredCandidates,
                            type: 'summary'
                        });
                    } else {
                        send({
                            ...candidate.toJSON(),
                            client: { id: clientId },
                            type: 'candidate'
                        });

                        numberOfGatheredCandidates += 1;
                    }
                });

                const emitChannel = (channel: RTCDataChannel): void => {
                    subject.complete();
                    observer.next(channel);
                    observer.complete();
                };

                const addFinalCandidate = async (numberOfNewlyAppliedCandidates: number) => {
                    numberOfAppliedCandidates += numberOfNewlyAppliedCandidates;

                    if (numberOfAppliedCandidates === numberOfExpectedCandidates) {
                        await peerConnection.addIceCandidate();
                    }
                };

                const jsonifyDescription = (description: RTCSessionDescription | RTCSessionDescriptionInit): RTCSessionDescriptionInit =>
                    description instanceof RTCSessionDescription ? description.toJSON() : description;

                const processEvent = (event: ICandidateEvent | IDescriptionEvent | IRequestEvent | ISummaryEvent) => {
                    const { type } = event;

                    if (type === 'answer') {
                        peerConnection.setRemoteDescription(event).then(async () => {
                            await Promise.all(receivedCandidates.map((candidate) => peerConnection.addIceCandidate(candidate)));
                            await addFinalCandidate(receivedCandidates.length);
                        });
                    } else if (type === 'candidate') {
                        if (peerConnection.remoteDescription === null) {
                            receivedCandidates.push(event);
                        } else {
                            peerConnection.addIceCandidate(event).then(() => addFinalCandidate(1));
                        }
                    } else if (type === 'offer') {
                        const unsubscribe = on(
                            peerConnection,
                            'datachannel'
                        )(({ channel }) => {
                            unsubscribe();
                            emitChannel(channel);
                        });

                        peerConnection.setRemoteDescription(event).then(async () => {
                            await Promise.all(receivedCandidates.map((candidate) => peerConnection.addIceCandidate(candidate)));
                            await addFinalCandidate(receivedCandidates.length);

                            const answer = await peerConnection.createAnswer();

                            await peerConnection.setLocalDescription(answer);

                            send({
                                ...jsonifyDescription(answer),
                                client: { id: clientId }
                            });
                        });
                    } else if (type === 'request') {
                        const dataChannel = peerConnection.createDataChannel(event.label, { ordered: true });

                        const unsubscribe = on(
                            dataChannel,
                            'open'
                        )(() => {
                            unsubscribe();
                            emitChannel(dataChannel);
                        });

                        peerConnection.createOffer().then(async (offer) => {
                            await peerConnection.setLocalDescription(offer);

                            send({
                                ...jsonifyDescription(offer),
                                client: { id: clientId }
                            });
                        });
                    } else if (type === 'summary') {
                        numberOfExpectedCandidates = event.numberOfGatheredCandidates;

                        addFinalCandidate(0);
                    }
                };

                return subject.subscribe({
                    complete: () => observer.complete(),
                    error: (err) => observer.error(err),
                    next: (event) => processEvent(event)
                });
            })
    );
