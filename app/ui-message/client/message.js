import _ from 'underscore';
import moment from 'moment';

import { Meteor } from 'meteor/meteor';
import { Blaze } from 'meteor/blaze';
import { Template } from 'meteor/templating';
import { TAPi18n } from 'meteor/tap:i18n';
import { ReactiveVar } from 'meteor/reactive-var';

import { timeAgo } from '../../lib/client/lib/formatDate';
import { DateFormat } from '../../lib/client';
import { renderMessageBody, MessageTypes, MessageAction, call, normalizeThreadMessage } from '../../ui-utils/client';
import { RoomRoles, UserRoles, Roles, Messages } from '../../models/client';
import { AutoTranslate } from '../../autotranslate/client';
import { callbacks } from '../../callbacks/client';
import { Markdown } from '../../markdown/client';
import { t, roomTypes, getURL } from '../../utils';

async function renderPdfToCanvas(canvasId, pdfLink) {
	const isSafari = /constructor/i.test(window.HTMLElement) ||
		((p) => p.toString() === '[object SafariRemoteNotification]')(!window.safari ||
			(typeof window.safari !== 'undefined' && window.safari.pushNotification));

	if (isSafari) {
		const [, version] = /Version\/([0-9]+)/.exec(navigator.userAgent) || [null, 0];
		if (version <= 12) {
			return;
		}
	}

	if (!pdfLink || !/\.pdf$/i.test(pdfLink)) {
		return;
	}
	pdfLink = getURL(pdfLink);

	const canvas = document.getElementById(canvasId);
	if (!canvas) {
		return;
	}

	const pdfjsLib = await import('pdfjs-dist');
	pdfjsLib.GlobalWorkerOptions.workerSrc = `${ Meteor.absoluteUrl() }pdf.worker.min.js`;

	const loader = document.getElementById(`js-loading-${ canvasId }`);

	if (loader) {
		loader.style.display = 'block';
	}

	const pdf = await pdfjsLib.getDocument(pdfLink);
	const page = await pdf.getPage(1);
	const scale = 0.5;
	const viewport = page.getViewport(scale);
	const context = canvas.getContext('2d');
	canvas.height = viewport.height;
	canvas.width = viewport.width;
	await page.render({
		canvasContext: context,
		viewport,
	}).promise;

	if (loader) {
		loader.style.display = 'none';
	}

	canvas.style.maxWidth = '-webkit-fill-available';
	canvas.style.maxWidth = '-moz-available';
	canvas.style.display = 'block';
}

Template.message.helpers({
	hover() {
		return Template.instance().hover.get();
	},
	and(a, b) {
		return a && b;
	},
	i18nKeyMessage() {
		const { msg } = this;
		return msg.dcount > 1
			? 'messages'
			: 'message';
	},
	i18nKeyReply() {
		const { msg } = this;
		return msg.tcount > 1
			? 'replies'
			: 'reply';
	},
	formatDate(date) {
		return moment(date).format('LLL');
	},
	encodeURI(text) {
		return encodeURI(text);
	},
	broadcast() {
		const { msg, room = {} } = this;
		return !msg.private && !msg.t && msg.u._id !== Meteor.userId() && room && room.broadcast;
	},
	isIgnored() {
		const { msg } = this;
		return msg.ignored;
	},
	ignoredClass() {
		const { msg } = this;
		return msg.ignored ? 'message--ignored' : '';
	},
	isDecrypting() {
		const { msg } = this;
		return msg.e2e === 'pending';
	},
	isBot() {
		const { msg } = this;
		return msg.bot && 'bot';
	},
	roleTags() {
		const { msg, hideRoles } = this;
		if (hideRoles) {
			return [];
		}

		if (!msg.u || !msg.u._id) {
			return [];
		}
		const userRoles = UserRoles.findOne(msg.u._id);
		const roomRoles = RoomRoles.findOne({
			'u._id': msg.u._id,
			rid: msg.rid,
		});
		const roles = [...(userRoles && userRoles.roles) || [], ...(roomRoles && roomRoles.roles) || []];
		return Roles.find({
			_id: {
				$in: roles,
			},
			description: {
				$exists: 1,
				$ne: '',
			},
		}, {
			fields: {
				description: 1,
			},
		});
	},
	isGroupable() {
		const { msg, room = {}, settings, groupable } = this;
		if (groupable === false || settings.allowGroup === false || room.broadcast || msg.groupable === false) {
			return 'false';
		}
	},
	sequentialClass() {
		const { msg } = this;
		return msg.groupable !== false && 'sequential';
	},
	avatarFromUsername() {
		const { msg } = this;

		if (msg.avatar != null && msg.avatar[0] === '@') {
			return msg.avatar.replace(/^@/, '');
		}
	},
	getName() {
		const { msg, settings } = this;
		if (msg.alias) {
			return msg.alias;
		}
		if (!msg.u) {
			return '';
		}
		return (settings.UI_Use_Real_Name && msg.u.name) || msg.u.username;
	},
	showUsername() {
		const { msg, settings } = this;
		return msg.alias || (settings.UI_Use_Real_Name && msg.u && msg.u.name);
	},
	own() {
		const { msg, u } = this;
		if (msg.u && msg.u._id === u._id) {
			return 'own';
		}
	},
	timestamp() {
		const { msg } = this;
		return +msg.ts;
	},
	chatops() {
		const { msg, settings } = this;
		if (msg.u && msg.u.username === settings.Chatops_Username) {
			return 'chatops-message';
		}
	},
	time() {
		const { msg, timeAgo: useTimeAgo } = this;

		return useTimeAgo ? timeAgo(msg.ts) : DateFormat.formatTime(msg.ts);
	},
	date() {
		const { msg } = this;
		return DateFormat.formatDate(msg.ts);
	},
	isTemp() {
		const { msg } = this;
		if (msg.temp === true) {
			return 'temp';
		}
	},
	body() {
		return Template.instance().body;
	},
	bodyClass() {
		const { msg } = this;
		return MessageTypes.isSystemMessage(msg) ? 'color-info-font-color' : 'color-primary-font-color';
	},
	system(returnClass) {
		const { msg } = this;
		if (MessageTypes.isSystemMessage(msg)) {
			if (returnClass) {
				return 'color-info-font-color';
			}
			return 'system';
		}
	},
	showTranslated() {
		const { msg, subscription, settings } = this;
		if (settings.AutoTranslate_Enabled && msg.u && msg.u._id !== Meteor.userId() && !MessageTypes.isSystemMessage(msg)) {
			const language = AutoTranslate.getLanguage(msg.rid);
			return msg.autoTranslateFetching || (subscription && subscription.autoTranslate !== msg.autoTranslateShowInverse && msg.translations && msg.translations[language]);
		}
	},
	edited() {
		return Template.instance().wasEdited;
	},
	editTime() {
		const { msg } = this;
		if (Template.instance().wasEdited) {
			return DateFormat.formatDateAndTime(msg.editedAt);
		}
	},
	editedBy() {
		if (!Template.instance().wasEdited) {
			return '';
		}
		const { msg } = this;
		// try to return the username of the editor,
		// otherwise a special "?" character that will be
		// rendered as a special avatar
		return (msg.editedBy && msg.editedBy.username) || '?';
	},
	label() {
		const { msg } = this;

		if (msg.i18nLabel) {
			return t(msg.i18nLabel);
		} else if (msg.label) {
			return msg.label;
		}
	},
	hasOembed() {
		const { msg, settings } = this;
		// there is no URLs, there is no template to show the oembed (oembed package removed) or oembed is not enable
		if (!(msg.urls && msg.urls.length > 0) || !Template.oembedBaseWidget || !settings.API_Embed) {
			return false;
		}

		// check if oembed is disabled for message's sender
		if ((settings.API_EmbedDisabledFor || '').split(',').map((username) => username.trim()).includes(msg.u && msg.u.username)) {
			return false;
		}
		return true;
	},
	reactions() {
		const { username: myUsername, name: myName } = Meteor.user() || {};
		const { msg: { reactions = {} } } = this;

		return Object.entries(reactions)
			.map(([emoji, reaction]) => {
				const myDisplayName = reaction.names ? myName : `@${ myUsername }`;
				const displayNames = (reaction.names || reaction.usernames.map((username) => `@${ username }`));
				const selectedDisplayNames = displayNames.slice(0, 15).filter((displayName) => displayName !== myDisplayName);

				if (displayNames.some((displayName) => displayName === myDisplayName)) {
					selectedDisplayNames.unshift(t('You'));
				}

				let usernames;

				if (displayNames.length > 15) {
					usernames = `${ selectedDisplayNames.join(', ') }${ t('And_more', { length: displayNames.length - 15 }).toLowerCase() }`;
				} else if (displayNames.length > 1) {
					usernames = `${ selectedDisplayNames.slice(0, -1).join(', ') } ${ t('and') } ${ selectedDisplayNames[selectedDisplayNames.length - 1] }`;
				} else {
					usernames = selectedDisplayNames[0];
				}

				return {
					emoji,
					count: displayNames.length,
					usernames,
					reaction: ` ${ t('Reacted_with').toLowerCase() } ${ emoji }`,
					userReacted: displayNames.indexOf(myDisplayName) > -1,
				};
			});
	},
	markUserReaction(reaction) {
		if (reaction.userReacted) {
			return {
				class: 'selected',
			};
		}
	},
	hideReactions() {
		const { msg } = this;
		if (_.isEmpty(msg.reactions)) {
			return 'hidden';
		}
	},
	actionLinks() {
		const { msg } = this;
		// remove 'method_id' and 'params' properties
		return _.map(msg.actionLinks, function(actionLink, key) {
			return _.extend({
				id: key,
			}, _.omit(actionLink, 'method_id', 'params'));
		});
	},
	hideActionLinks() {
		const { msg } = this;
		if (_.isEmpty(msg.actionLinks)) {
			return 'hidden';
		}
	},
	injectIndex(data, index) {
		data.index = index;
	},
	channelName() {
		const { subscription } = this;
		// const subscription = Subscriptions.findOne({ rid: this.rid });
		return subscription && subscription.name;
	},
	roomIcon() {
		const { room } = this;
		if (room && room.t === 'd') {
			return 'at';
		}
		return roomTypes.getIcon(room);
	},
	fromSearch() {
		const { customClass } = this;
		return customClass === 'search';
	},
	actionContext() {
		const { msg } = this;
		return msg.actionContext;
	},
	messageActions(group) {
		const { msg, context: ctx } = this;
		let messageGroup = group;
		let context = ctx || msg.actionContext;

		if (!group) {
			messageGroup = 'message';
		}

		if (!context) {
			context = 'message';
		}

		return MessageAction.getButtons(msg, context, messageGroup);
	},
	isSnippet() {
		const { msg } = this;
		return msg.actionContext === 'snippeted';
	},
	parentMessage() {
		const { msg: { threadMsg } } = this;
		return threadMsg;
	},
});


const findParentMessage = (() => {

	const waiting = [];

	const getMessages = _.debounce(async function() {
		const _tmp = [...waiting];
		waiting.length = 0;
		const messages = await call('getMessages', _tmp);
		messages.forEach((message) => {
			if (!message) {
				return;
			}
			const { _id, ...msg } = message;
			Messages.update({ tmid: _id }, {
				$set: {
					threadMsg: normalizeThreadMessage(msg),
					repliesCount: msg.tcount,
				},
			}, { multi: true });
			Messages.upsert({ _id }, msg);
		});
	}, 500);

	return (tmid) => {
		if (waiting.indexOf(tmid) > -1) {
			return;
		}

		const message = Messages.findOne({ _id: tmid });

		if (message) {
			return;
		}

		waiting.push(tmid);
		getMessages();
	};
})();


const renderBody = (msg, settings) => {
	const isSystemMessage = MessageTypes.isSystemMessage(msg);
	const messageType = MessageTypes.getType(msg) || {};
	if (msg.thread_message) {
		msg.reply = Markdown.parse(TAPi18n.__('Thread_message', {
			username: msg.u.username,
			msg: msg.thread_message.msg,
		}));
	}

	if (messageType.render) {
		msg = messageType.render(msg);
	} else if (messageType.template) {
		// render template
	} else if (messageType.message) {
		msg = TAPi18n.__(messageType.message, { ... typeof messageType.data === 'function' && messageType.data(msg) });
	} else if (msg.u && msg.u.username === settings.Chatops_Username) {
		msg.html = msg.msg;
		msg = callbacks.run('renderMentions', msg);
		msg = msg.html;
	} else {
		msg = renderMessageBody(msg);
	}

	if (isSystemMessage) {
		msg.html = Markdown.parse(msg.html);
	}
	return msg;
};

Template.message.onCreated(function() {
	this.hover = new ReactiveVar(false);
	// const [, currentData] = Template.currentData()._arguments;
	// const { msg, settings } = currentData.hash;
	const { msg, settings } = Template.currentData();

	this.wasEdited = msg.editedAt && !MessageTypes.isSystemMessage(msg);
	if (msg.tmid && !msg.thread_message) {
		findParentMessage(msg.tmid);
	}
	return this.body = renderBody(msg, settings);
});

const hasTempClass = (node) => node.classList.contains('temp');


const getPreviousSentMessage = (currentNode) => {
	if (hasTempClass(currentNode)) {
		return currentNode.previousElementSibling;
	}
	if (currentNode.previousElementSibling != null) {
		let previousValid = currentNode.previousElementSibling;
		while (previousValid != null && (hasTempClass(previousValid) || !previousValid.classList.contains('message'))) {
			previousValid = previousValid.previousElementSibling;
		}
		return previousValid;
	}
};

const setNewDayAndGroup = (currentNode, previousNode, forceDate, period, noDate) => {


	const { classList } = currentNode;

	// const $nextNode = $(nextNode);
	if (previousNode == null) {

		classList.remove('sequential');
		return !noDate && classList.add('new-day');
	}

	const previousDataset = previousNode.dataset;
	const currentDataset = currentNode.dataset;
	const previousMessageDate = new Date(parseInt(previousDataset.timestamp));
	const currentMessageDate = new Date(parseInt(currentDataset.timestamp));

	if (!noDate && (forceDate || previousMessageDate.toDateString() !== currentMessageDate.toDateString())) {
		classList.add('new-day');
	}


	if (previousDataset.tmid !== currentDataset.tmid) {
		return classList.remove('sequential');
	}

	if (previousDataset.username !== currentDataset.username || parseInt(currentDataset.timestamp) - parseInt(previousDataset.timestamp) > period) {
		return classList.remove('sequential');
	}

	if ([previousDataset.groupable, currentDataset.groupable].includes('false')) {
		return classList.remove('sequential');
	}

};

Template.message.onViewRendered = function(context) {
	const [, currentData] = Template.currentData()._arguments;
	const { settings, forceDate, noDate } = currentData.hash;
	return this._domrange.onAttached((domRange) => {
		if (context.file && context.file.type === 'application/pdf') {
			Meteor.defer(() => { renderPdfToCanvas(context.file._id, context.attachments[0].title_link); });
		}
		const currentNode = domRange.lastNode();
		const currentDataset = currentNode.dataset;
		const previousNode = getPreviousSentMessage(currentNode);
		const nextNode = currentNode.nextElementSibling;
		setNewDayAndGroup(currentNode, previousNode, forceDate, settings.Message_GroupingPeriod, noDate);
		if (nextNode && nextNode.dataset) {
			const nextDataset = nextNode.dataset;
			if (forceDate || nextDataset.date !== currentDataset.date) {
				if (!noDate) {
					currentNode.classList.add('new-day');
				}
				currentNode.classList.remove('sequential');
			} else {
				nextNode.classList.remove('new-day');
			}
			if (nextDataset.groupable !== 'false') {
				if (nextDataset.tmid !== currentDataset.tmid || nextDataset.username !== currentDataset.username || parseInt(nextDataset.timestamp) - parseInt(currentDataset.timestamp) > settings.Message_GroupingPeriod) {
					nextNode.classList.remove('sequential');
				} else if (!nextNode.classList.contains('new-day') && !currentNode.classList.contains('temp')) {
					nextNode.classList.add('sequential');
				}
			}
		} else {
			const [el] = $(`#chat-window-${ context.rid }`);
			const view = el && Blaze.getView(el);
			const templateInstance = view && view.templateInstance();
			if (!templateInstance) {
				return;
			}

			if (currentNode.classList.contains('own') === true) {
				templateInstance.atBottom = true;
			}
			templateInstance.sendToBottomIfNecessary();
		}

	});

};
